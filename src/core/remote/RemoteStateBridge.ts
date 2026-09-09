import { EventEmitter } from "events"

import type { ClineMessage, TaskLike, ProviderSettings } from "@roo-code/types"
import { DEFAULT_MODES, RooCodeEventName, getModelId, TaskStatus } from "@roo-code/types"

import { REMOTE_API_VERSION } from "./types"
import type {
	RemoteActivityPayload,
	RemoteEventSource,
	RemoteStateSource,
	RemoteStatus,
	RemoteTaskSource,
} from "./types"

/** Bridge → server events (consumed by the RemoteServer to push WS frames). */
export const REMOTE_STATUS_EVENT = "remoteStatus" as const
export const REMOTE_ACTIVITY_EVENT = "remoteActivity" as const

/** Contract limits (docs/architektur.md §3). */
const SUMMARY_MAX_CHARS = 500
const ACTIVITY_TEXT_MAX_CHARS = 2000
/** Status push debounce. */
const STATUS_DEBOUNCE_MS = 200
/** Per-line partial throttle: at most one emit per ts within this window (~10 Hz). */
const PARTIAL_THROTTLE_MS = 100

/** Categories that do not belong in the app's chat feed (internal bookkeeping / raw data). */
const FILTERED_ACTIVITY_CATEGORIES = new Set<string>([
	"api_req_started",
	"api_req_retry_delayed",
	"checkpoint_saved",
	"shell_integration_warning",
	"condense_context",
	"sliding_window_truncation",
	"codebase_search_result",
	"too_many_tools_warning",
])

/** Asks where yes/no buttons make sense. */
const APPROVE_ASK_TYPES = new Set<string>([
	"tool",
	"command",
	"use_mcp_server",
	"auto_approval_max_req_reached",
	"api_req_failed",
	"completion_result",
	"resume_task",
	"resume_completed_task",
	"mistake_limit_reached",
])

/** Asks where a free-text answer is expected. */
const TEXT_ASK_TYPES = new Set<string>(["followup", "completion_result"])

function truncate(value: string, maxChars: number): string {
	return value.length > maxChars ? value.slice(0, maxChars - 1) + "…" : value
}

/**
 * Maps one ClineMessage to the app's activity feed. Returns undefined for
 * internal categories that should not be shown (see FILTERED_ACTIVITY_CATEGORIES).
 */
export function toActivityPayload(message: ClineMessage): RemoteActivityPayload | undefined {
	const category = message.type === "ask" ? message.ask : message.say
	if (!category || FILTERED_ACTIVITY_CATEGORIES.has(category)) {
		return undefined
	}

	const payload: RemoteActivityPayload = { ts: message.ts, kind: message.type, category }
	if (typeof message.text === "string" && message.text.length > 0) {
		payload.text = truncate(message.text, ACTIVITY_TEXT_MAX_CHARS)
	}
	if (message.partial === true) {
		payload.partial = true
	}
	if (message.type === "ask") {
		// Codebase convention: an ask is pending while `isAnswered !== true`.
		payload.answered = message.isAnswered === true
	}
	return payload
}

function resolveModeLabel(state: RemoteStateSource): string {
	const slug = state.mode ?? ""
	const custom = (state.customModes ?? []).find((mode) => mode.slug === slug)
	if (custom && custom.name) {
		return custom.name
	}
	return DEFAULT_MODES.find((mode) => mode.slug === slug)?.name ?? slug
}

function lastAssistantSummary(task: RemoteTaskSource): string | undefined {
	for (let i = task.clineMessages.length - 1; i >= 0; i--) {
		const message = task.clineMessages[i]
		if ((message.type === "say" && message.say === "text") || message.type === "ask") {
			if (typeof message.text === "string" && message.text.trim().length > 0) {
				return truncate(message.text, SUMMARY_MAX_CHARS)
			}
		}
	}
	return undefined
}

function mapPendingAsk(ask: ClineMessage | undefined): NonNullable<RemoteStatus["task"]["pendingAsk"]> {
	const askType = ask && ask.type === "ask" ? (ask.ask ?? "") : ""
	const pendingAsk: NonNullable<RemoteStatus["task"]["pendingAsk"]> = {
		askType,
		canApprove: APPROVE_ASK_TYPES.has(askType),
		expectsText: TEXT_ASK_TYPES.has(askType),
	}
	if (typeof ask?.text === "string" && ask.text.length > 0) {
		pendingAsk.question = truncate(ask.text, ACTIVITY_TEXT_MAX_CHARS)
	}
	return pendingAsk
}

function mapTask(task: RemoteTaskSource | undefined): RemoteStatus["task"] {
	if (!task || task.abort === true || task.abandoned === true) {
		return { state: "idle" }
	}

	const base: RemoteStatus["task"] = { state: "idle", taskId: task.taskId }
	const summary = lastAssistantSummary(task)
	if (summary) {
		base.summary = summary
	}

	switch (task.taskStatus) {
		case TaskStatus.Interactive:
		case TaskStatus.Resumable:
			return { ...base, state: "waiting_for_input", pendingAsk: mapPendingAsk(task.taskAsk) }
		case TaskStatus.Idle: {
			const ask = task.taskAsk
			if (ask && ask.type === "ask") {
				if (ask.ask === "completion_result") {
					return { ...base, state: "completed" }
				}
				if (ask.ask === "api_req_failed") {
					return { ...base, state: "error" }
				}
			}
			return base
		}
		case TaskStatus.Running:
			return { ...base, state: "running" }
		default:
			return base
	}
}

/** Builds the `RemoteStatus` contract object from provider state + active task. */
export function buildRemoteStatus(state: RemoteStateSource, task: RemoteTaskSource | undefined): RemoteStatus {
	const apiConfiguration = (state.apiConfiguration ?? {}) as ProviderSettings
	return {
		connection: { extensionVersion: state.version ?? "", apiVersion: REMOTE_API_VERSION },
		task: mapTask(task),
		mode: { current: state.mode ?? "", label: resolveModeLabel(state) },
		model: {
			profileName: state.currentApiConfigName,
			modelId: getModelId(apiConfiguration),
			provider: typeof apiConfiguration.apiProvider === "string" ? apiConfiguration.apiProvider : undefined,
		},
	}
}

type StatusListener = (status: RemoteStatus) => void
type ActivityListener = (payload: RemoteActivityPayload) => void
type TaskMessageEvent = { action: "created" | "updated"; message: ClineMessage }

/** Provider events that can change the remote status. */
const STATUS_PROVIDER_EVENTS = [
	RooCodeEventName.TaskStarted,
	RooCodeEventName.TaskCompleted,
	RooCodeEventName.TaskAborted,
	RooCodeEventName.TaskActive,
	RooCodeEventName.TaskInteractive,
	RooCodeEventName.TaskResumable,
	RooCodeEventName.TaskIdle,
	RooCodeEventName.ModeChanged,
	RooCodeEventName.ProviderProfileChanged,
] as const

/**
 * Bridges the ClineProvider/Task world to the remote API.
 *
 * - `buildStatus()` — on-demand snapshot for `GET /api/status` and WS connect.
 * - `subscribe(cb)` — pushes a new `RemoteStatus` whenever provider/task state changes
 *   (debounced 200 ms, deduplicated by serialized status).
 * - `subscribeActivity(cb)` — streams `RemoteActivityPayload`s from the active task's
 *   Task-Events `Message` events (partials throttled to ~10 Hz per line, finals immediate).
 * - `getRecentActivity(limit)` — snapshot of the last feed entries for WS connect.
 */
export class RemoteStateBridge extends EventEmitter {
	private readonly source: RemoteEventSource
	private readonly log?: (line: string) => void
	private statusListeners = new Set<StatusListener>()
	private activityListeners = new Set<ActivityListener>()
	private lastStatusJson: string | null = null
	private statusDebounceTimer?: ReturnType<typeof setTimeout>
	/** The task instance whose Message events are currently streamed (kept by reference for clean detach). */
	private trackedTask?: RemoteTaskSource
	private messageHandler: ((event: TaskMessageEvent) => void) | undefined
	/** ts → timestamp of the last emitted payload for that line (partial throttle). */
	private partialLastSentAt = new Map<number, number>()
	private started = false
	private onTaskCreated?: (task: TaskLike) => void
	private onProviderEvent?: () => void

	constructor(source: RemoteEventSource, log?: (line: string) => void) {
		super()
		this.source = source
		this.log = log
	}

	start(): void {
		if (this.started) {
			return
		}
		this.started = true
		this.onTaskCreated = (task: TaskLike) => {
			this.attachToTask(task as unknown as RemoteTaskSource)
			this.scheduleStatusRefresh()
		}
		this.onProviderEvent = () => this.scheduleStatusRefresh()

		this.source.on(RooCodeEventName.TaskCreated, this.onTaskCreated)
		for (const event of STATUS_PROVIDER_EVENTS) {
			this.source.on(event, this.onProviderEvent)
		}

		this.syncTrackedTask()
	}

	stop(): void {
		if (!this.started) {
			return
		}
		this.started = false
		if (this.onTaskCreated) {
			this.source.off(RooCodeEventName.TaskCreated, this.onTaskCreated)
			this.onTaskCreated = undefined
		}
		for (const event of STATUS_PROVIDER_EVENTS) {
			if (this.onProviderEvent) {
				this.source.off(event, this.onProviderEvent)
			}
		}
		this.onProviderEvent = undefined
		const tracked = this.trackedTask
		if (tracked && this.messageHandler) {
			tracked.off(RooCodeEventName.Message, this.messageHandler)
		}
		this.trackedTask = undefined
		this.messageHandler = undefined
		if (this.statusDebounceTimer) {
			clearTimeout(this.statusDebounceTimer)
			this.statusDebounceTimer = undefined
		}
	}

	/** Current status snapshot (for `GET /api/status` and the WS connect snapshot). */
	async buildStatus(): Promise<RemoteStatus> {
		const state = await this.source.getStateToPostToWebview({ includeTaskHistory: false })
		return buildRemoteStatus(state, this.source.getCurrentTask())
	}

	subscribe(listener: StatusListener): () => void {
		this.statusListeners.add(listener)
		return () => {
			this.statusListeners.delete(listener)
		}
	}

	subscribeActivity(listener: ActivityListener): () => void {
		this.activityListeners.add(listener)
		return () => {
			this.activityListeners.delete(listener)
		}
	}

	/** Last feed entries of the active task (same mapping/filtering as the live stream). */
	getRecentActivity(limit = 50): RemoteActivityPayload[] {
		const task = this.source.getCurrentTask()
		if (!task) {
			return []
		}
		const results: RemoteActivityPayload[] = []
		for (const message of task.clineMessages) {
			const payload = toActivityPayload(message)
			if (payload) {
				results.push(payload)
			}
		}
		return results.slice(-limit)
	}

	private syncTrackedTask(): void {
		const current = this.source.getCurrentTask()
		if (current !== this.trackedTask) {
			this.attachToTask(current)
		}
	}

	private attachToTask(task: RemoteTaskSource | undefined): void {
		const prev = this.trackedTask
		if (prev && this.messageHandler) {
			prev.off(RooCodeEventName.Message, this.messageHandler)
		}
		this.trackedTask = task
		this.messageHandler = undefined
		if (!task) {
			return
		}
		this.partialLastSentAt.clear()
		const handler = (event: TaskMessageEvent) => this.onTaskMessage(event.message, task)
		this.messageHandler = handler
		task.on(RooCodeEventName.Message, handler)
	}

	private onTaskMessage(message: ClineMessage, from: RemoteTaskSource): void {
		if (from !== this.trackedTask || this.source.getCurrentTask() !== from) {
			return
		}

		const payload = toActivityPayload(message)
		if (payload) {
			this.emitActivity(payload)
		}
		// Message updates can change the status (pending ask, summary) — refresh is debounced.
		this.scheduleStatusRefresh()
	}

	private emitActivity(payload: RemoteActivityPayload): void {
		const now = Date.now()
		if (payload.partial === true) {
			const lastSentAt = this.partialLastSentAt.get(payload.ts) ?? 0
			if (now - lastSentAt < PARTIAL_THROTTLE_MS) {
				return
			}
		} else {
			this.partialLastSentAt.delete(payload.ts)
		}
		this.partialLastSentAt.set(payload.ts, now)

		for (const listener of [...this.activityListeners]) {
			try {
				listener(payload)
			} catch (error) {
				this.log?.("Activity listener error: " + (error instanceof Error ? error.message : String(error)))
			}
		}
		this.emit(REMOTE_ACTIVITY_EVENT, payload)
	}

	private scheduleStatusRefresh(): void {
		if (this.statusDebounceTimer) {
			return
		}
		const timer = setTimeout(() => {
			this.statusDebounceTimer = undefined
			void this.refreshStatus()
		}, STATUS_DEBOUNCE_MS)
		timer.unref?.()
		this.statusDebounceTimer = timer
	}

	private async refreshStatus(): Promise<void> {
		try {
			// Pick up task switches that did not come through a lifecycle event (e.g. history navigation).
			this.syncTrackedTask()
			const state = await this.source.getStateToPostToWebview({ includeTaskHistory: false })
			const status = buildRemoteStatus(state, this.source.getCurrentTask())
			const json = JSON.stringify(status)
			if (json === this.lastStatusJson) {
				return
			}
			this.lastStatusJson = json

			for (const listener of [...this.statusListeners]) {
				try {
					listener(status)
				} catch (error) {
					this.log?.("Status listener error: " + (error instanceof Error ? error.message : String(error)))
				}
			}
			this.emit(REMOTE_STATUS_EVENT, status)
		} catch (error) {
			this.log?.("Status refresh failed: " + (error instanceof Error ? error.message : String(error)))
		}
	}
}
