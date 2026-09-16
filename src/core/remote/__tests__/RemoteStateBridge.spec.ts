import { EventEmitter } from "events"

import type { ClineMessage, ModelInfo, TaskLike } from "@roo-code/types"
import { RooCodeEventName, TaskStatus, providerIdentifiers } from "@roo-code/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RemoteStateBridge, buildRemoteStatus, parseFollowUpSuggestions, toActivityPayload } from "../RemoteStateBridge"
import type { RemoteActivityPayload, RemoteEventSource, RemoteStateSource, RemoteTaskSource, RemoteStatus } from "../types"

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

/** Mutable variant of RemoteTaskSource so tests can flip status/ask. */
interface MockTask extends Omit<RemoteTaskSource, "taskStatus" | "taskAsk"> {
	taskStatus: TaskStatus
	taskAsk: ClineMessage | undefined
}

const mockTaskEmitters = new WeakMap<object, EventEmitter>()

function createMockTask(overrides: Partial<MockTask> = {}): MockTask {
	const emitter = new EventEmitter()
	const task = {
		taskId: "task-1",
		taskStatus: TaskStatus.Running,
		taskAsk: undefined,
		abort: false,
		abandoned: false,
		clineMessages: [],
		on: ((event: string | symbol, listener: (...args: unknown[]) => void) =>
			emitter.on(event, listener)) as unknown as MockTask["on"],
		off: ((event: string | symbol, listener: (...args: unknown[]) => void) =>
			emitter.off(event, listener)) as unknown as MockTask["off"],
		...overrides,
	} as unknown as MockTask
	mockTaskEmitters.set(task, emitter)
	return task
}

function emitMessage(task: RemoteTaskSource, message: ClineMessage): void {
	const emitter = mockTaskEmitters.get(task)
	emitter?.emit(RooCodeEventName.Message, { action: "created", message })
}

class MockProvider extends EventEmitter {
	task?: RemoteTaskSource
	state: RemoteStateSource = {
		version: "9.9.9-test",
		mode: "code",
		customModes: [],
		currentApiConfigName: "default",
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" },
	}

	getCurrentTask(): RemoteTaskSource | undefined {
		return this.task
	}

	async getStateToPostToWebview(_options?: { includeTaskHistory?: boolean }): Promise<RemoteStateSource> {
		return this.state
	}
}

function asEventSource(provider: MockProvider): RemoteEventSource {
	return provider as unknown as RemoteEventSource
}

function makeMessage(overrides: Partial<ClineMessage>): ClineMessage {
	return { ts: 1, type: "say", say: "text", ...overrides } as ClineMessage
}

/* ------------------------------------------------------------------ */
/* toActivityPayload                                                   */
/* ------------------------------------------------------------------ */

describe("toActivityPayload", () => {
	it("maps a reasoning partial with text and partial flag", () => {
		const payload = toActivityPayload(makeMessage({ ts: 42, say: "reasoning", text: "thinking…", partial: true }))
		expect(payload).toEqual({ ts: 42, kind: "say", category: "reasoning", text: "thinking…", partial: true })
	})

	it("omits internal categories from the feed", () => {
		for (const category of [
			"api_req_started",
			"api_req_retry_delayed",
			"checkpoint_saved",
			"shell_integration_warning",
			"condense_context",
			"sliding_window_truncation",
			"codebase_search_result",
			"too_many_tools_warning",
		]) {
			expect(toActivityPayload(makeMessage({ say: category as ClineMessage["say"] }))).toBeUndefined()
		}
	})

	it("truncates text to 2000 characters with an ellipsis", () => {
		const longText = "a".repeat(2500)
		const payload = toActivityPayload(makeMessage({ say: "text", text: longText }))
		expect(payload?.text).toHaveLength(2000)
		expect(payload?.text?.endsWith("…")).toBe(true)
	})

	it("marks asks as answered only when isAnswered is true", () => {
		const pending = toActivityPayload(makeMessage({ type: "ask", ask: "tool", text: "run ls?" }))
		expect(pending).toMatchObject({ kind: "ask", category: "tool", answered: false })

		const answered = toActivityPayload(makeMessage({ type: "ask", ask: "tool", isAnswered: true }))
		expect(answered?.answered).toBe(true)
	})
})

/* ------------------------------------------------------------------ */
/* buildRemoteStatus                                                   */
/* ------------------------------------------------------------------ */

const baseState: RemoteStateSource = {
	version: "9.9.9-test",
	mode: "code",
	customModes: [],
	currentApiConfigName: "default",
	apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" },
}

const KNOWN_MODES = ["code", "architect", "ask", "debug", "orchestrator"] as const

function makeTokenUsage(contextTokens: number) {
	return { totalTokensIn: contextTokens, totalTokensOut: 0, totalRequests: 1, totalCost: 0, contextTokens }
}

/** Minimal ModelInfo (only the fields buildRemoteStatus reads). */
const modelInfoWithWindow = (contextWindow: number): ModelInfo =>
	({ maxTokens: null, contextWindow, supportsPromptCache: false }) as unknown as ModelInfo

function createMockTaskWithContext(
	overrides: Partial<MockTask> & { tokenUsage?: unknown; api?: RemoteTaskSource["api"] } = {},
): MockTask {
	const { tokenUsage, api, ...rest } = overrides
	return createMockTask({
		tokenUsage: undefined,
		api: undefined,
		...rest,
		...(tokenUsage !== undefined ? { tokenUsage } : {}),
		...(api !== undefined ? { api } : {}),
	} as Partial<MockTask>)
}

describe("buildRemoteStatus", () => {
	it("reports idle without a task and resolves the mode label + model info", () => {
		const status = buildRemoteStatus(baseState, undefined)
		expect(status.connection).toEqual({ extensionVersion: "9.9.9-test", apiVersion: "1" })
		expect(status.task.state).toBe("idle")
		expect(status.task.taskId).toBeUndefined()
		expect(status.mode).toEqual({ current: "code", label: "💻 Code" })
		expect(status.model).toEqual({
			profileName: "default",
			modelId: "claude-sonnet-4-5",
			provider: providerIdentifiers.anthropic,
		})
	})

	it("resolves custom mode labels from the state", () => {
		const status = buildRemoteStatus(
			{ ...baseState, mode: "my-mode", customModes: [{ slug: "my-mode", name: "My Custom Mode" }] },
			undefined,
		)
		expect(status.mode).toEqual({ current: "my-mode", label: "My Custom Mode" })
	})

	it("reports running with a summary truncated to 500 characters", () => {
		const task = createMockTask({
			taskStatus: TaskStatus.Running,
			clineMessages: [makeMessage({ ts: 1, say: "text", text: "b".repeat(800) })],
		})
		const status = buildRemoteStatus(baseState, task)
		expect(status.task.state).toBe("running")
		expect(status.task.summary).toHaveLength(500)
		expect(status.task.summary?.endsWith("…")).toBe(true)
	})

	it("reports waiting_for_input with canApprove for a tool ask", () => {
		const ask = makeMessage({ ts: 2, type: "ask", ask: "tool", text: "Run `ls` in the workspace?" })
		const task = createMockTask({ taskStatus: TaskStatus.Interactive, taskAsk: ask })
		const status = buildRemoteStatus(baseState, task)
		expect(status.task.state).toBe("waiting_for_input")
		expect(status.task.pendingAsk).toEqual({
			askType: "tool",
			question: "Run `ls` in the workspace?",
			canApprove: true,
			expectsText: false,
		})
	})

	it("reports waiting_for_input with expectsText for a followup ask", () => {
		const ask = makeMessage({ ts: 3, type: "ask", ask: "followup", text: "Which framework?" })
		const task = createMockTask({ taskStatus: TaskStatus.Interactive, taskAsk: ask })
		const status = buildRemoteStatus(baseState, task)
		expect(status.task.pendingAsk).toEqual({
			askType: "followup",
			question: "Which framework?",
			canApprove: false,
			expectsText: true,
		})
	})

	it("maps an idle completion_result ask to completed and api_req_failed to error", () => {
		const done = createMockTask({
			taskStatus: TaskStatus.Idle,
			taskAsk: makeMessage({ ts: 4, type: "ask", ask: "completion_result" }),
		})
		expect(buildRemoteStatus(baseState, done).task.state).toBe("completed")

		const failed = createMockTask({
			taskStatus: TaskStatus.Idle,
			taskAsk: makeMessage({ ts: 5, type: "ask", ask: "api_req_failed" }),
		})
		expect(buildRemoteStatus(baseState, failed).task.state).toBe("error")
	})

	it("reports idle for aborted or abandoned tasks even with a pending ask", () => {
		const task = createMockTask({
			taskStatus: TaskStatus.Interactive,
			taskAsk: makeMessage({ ts: 6, type: "ask", ask: "tool" }),
			abort: true,
		})
		expect(buildRemoteStatus(baseState, task).task.state).toBe("idle")
	})

	it("omits contextWindow without a task or without token usage", () => {
		expect(buildRemoteStatus(baseState, undefined).task.contextWindow).toBeUndefined()

		const noUsage = createMockTask({ taskStatus: TaskStatus.Running })
		expect(buildRemoteStatus(baseState, noUsage).task.contextWindow).toBeUndefined()
	})

	it("reports contextWindow with used + limit + percent when both are known", () => {
		const task = createMockTaskWithContext({
			taskStatus: TaskStatus.Running,
			tokenUsage: makeTokenUsage(123_456),
			api: { getModel: () => ({ id: "claude-sonnet-4-5", info: modelInfoWithWindow(200_000) }) },
		})
		expect(buildRemoteStatus(baseState, task).task.contextWindow).toEqual({
			used: 123_456,
			limit: 200_000,
			percent: 61.73,
		})
	})

	it("reports only `used` when the model context window is unknown", () => {
		const noModelInfo = createMockTaskWithContext({
			taskStatus: TaskStatus.Running,
			tokenUsage: makeTokenUsage(50_000),
		})
		expect(buildRemoteStatus(baseState, noModelInfo).task.contextWindow).toEqual({ used: 50_000 })

		const zeroWindow = createMockTaskWithContext({
			taskStatus: TaskStatus.Running,
			tokenUsage: makeTokenUsage(50_000),
			api: { getModel: () => ({ id: "x", info: modelInfoWithWindow(0) }) },
		})
		expect(buildRemoteStatus(baseState, zeroWindow).task.contextWindow).toEqual({ used: 50_000 })

		const throwingGetModel = createMockTaskWithContext({
			taskStatus: TaskStatus.Running,
			tokenUsage: makeTokenUsage(50_000),
			api: {
				getModel: () => {
					throw new Error("boom")
				},
			},
		})
		expect(buildRemoteStatus(baseState, throwingGetModel).task.contextWindow).toEqual({ used: 50_000 })
	})

	it("includes followup suggestions in pendingAsk and keeps only known mode slugs", () => {
		const text = JSON.stringify({
			question: "Which framework?",
			suggest: [
				{ answer: "Use React" },
				{ answer: "Switch to Architect", mode: "architect" },
				{ answer: "Unknown target", mode: "nope" },
				{ answer: "" },
				{ answer: "  Spaced answer  " },
			],
		})
		const ask = makeMessage({ ts: 7, type: "ask", ask: "followup", text })
		const task = createMockTask({ taskStatus: TaskStatus.Interactive, taskAsk: ask })

		expect(buildRemoteStatus(baseState, task).task.pendingAsk?.suggestions).toEqual([
			{ answer: "Use React" },
			{ answer: "Switch to Architect", mode: "architect" },
			{ answer: "Unknown target" },
			{ answer: "Spaced answer" },
		])
	})

	it("does not set suggestions for non-followup asks or unparseable followup text", () => {
		const toolAsk = createMockTask({
			taskStatus: TaskStatus.Interactive,
			taskAsk: makeMessage({
				ts: 8,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ suggest: [{ answer: "x" }] }),
			}),
		})
		expect(buildRemoteStatus(baseState, toolAsk).task.pendingAsk?.suggestions).toBeUndefined()

		const brokenJson = createMockTask({
			taskStatus: TaskStatus.Interactive,
			taskAsk: makeMessage({ ts: 9, type: "ask", ask: "followup", text: "{ not json" }),
		})
		expect(buildRemoteStatus(baseState, brokenJson).task.pendingAsk?.suggestions).toBeUndefined()
	})

	it("accepts custom mode slugs from the state as valid suggestion modes", () => {
		const state = { ...baseState, customModes: [{ slug: "my-mode", name: "My Custom Mode" }] }
		const text = JSON.stringify({ suggest: [{ answer: "Do it my way", mode: "my-mode" }, { answer: "Plain" }] })
		const ask = makeMessage({ ts: 10, type: "ask", ask: "followup", text })
		const task = createMockTask({ taskStatus: TaskStatus.Interactive, taskAsk: ask })

		expect(buildRemoteStatus(state, task).task.pendingAsk?.suggestions).toEqual([
			{ answer: "Do it my way", mode: "my-mode" },
			{ answer: "Plain" },
		])
	})
})

/* ------------------------------------------------------------------ */
/* parseFollowUpSuggestions                                            */
/* ------------------------------------------------------------------ */

describe("parseFollowUpSuggestions", () => {
	it("parses a valid follow-up payload with suggestions and modes", () => {
		const text = JSON.stringify({
			question: "How to proceed?",
			suggest: [{ answer: "Continue", mode: "code" }, { answer: "Stop here" }],
		})
		expect(parseFollowUpSuggestions(text, KNOWN_MODES)).toEqual([
			{ answer: "Continue", mode: "code" },
			{ answer: "Stop here" },
		])
	})

	it("returns undefined for empty or non-string text", () => {
		expect(parseFollowUpSuggestions(undefined, KNOWN_MODES)).toBeUndefined()
		expect(parseFollowUpSuggestions("", KNOWN_MODES)).toBeUndefined()
		expect(parseFollowUpSuggestions("   ", KNOWN_MODES)).toBeUndefined()
	})

	it("returns undefined for broken JSON or non-object payloads", () => {
		for (const text of ["{ not json", "42", '"plain"', "[1, 2]", "null"]) {
			expect(parseFollowUpSuggestions(text, KNOWN_MODES)).toBeUndefined()
		}
	})

	it("returns undefined when suggest is missing or no entry has a usable answer", () => {
		expect(parseFollowUpSuggestions(JSON.stringify({ question: "q" }), KNOWN_MODES)).toBeUndefined()
		expect(parseFollowUpSuggestions(JSON.stringify({ suggest: "nope" }), KNOWN_MODES)).toBeUndefined()
		expect(
			parseFollowUpSuggestions(JSON.stringify({ suggest: [{}, { answer: "" }, { answer: 7 }] }), KNOWN_MODES),
		).toBeUndefined()
	})

	it("truncates to the first 4 suggestions and answers to 200 characters", () => {
		const text = JSON.stringify({
			suggest: [1, 2, 3, 4, 5].map((n) => ({ answer: `${n} ${"a".repeat(250)}` })),
		})
		const result = parseFollowUpSuggestions(text, KNOWN_MODES)
		expect(result).toHaveLength(4)
		for (const suggestion of result ?? []) {
			expect(suggestion.answer).toHaveLength(200)
			expect(suggestion.answer.endsWith("…")).toBe(true)
		}
	})

	it("drops unknown mode slugs but keeps the answer", () => {
		const text = JSON.stringify({
			suggest: [
				{ answer: "A", mode: "nope" },
				{ answer: "B", mode: "" },
			],
		})
		expect(parseFollowUpSuggestions(text, KNOWN_MODES)).toEqual([{ answer: "A" }, { answer: "B" }])
	})
})

/* ------------------------------------------------------------------ */
/* RemoteStateBridge (live behavior)                                   */
/* ------------------------------------------------------------------ */

describe("RemoteStateBridge", () => {
	let provider: MockProvider
	let bridge: RemoteStateBridge

	beforeEach(() => {
		vi.useFakeTimers()
		provider = new MockProvider()
		bridge = new RemoteStateBridge(asEventSource(provider))
	})

	afterEach(async () => {
		bridge.stop()
		await vi.advanceTimersByTimeAsync(500) // flush any pending status refresh
		vi.useRealTimers()
	})

	it("pushes a status update on task lifecycle events and deduplicates unchanged statuses", async () => {
		const seen: RemoteStatus[] = []
		bridge.subscribe((status) => seen.push(status))
		bridge.start()

		// Task starts running.
		const task = createMockTask({ clineMessages: [makeMessage({ ts: 1, say: "text", text: "working" })] })
		provider.task = task
		provider.emit(RooCodeEventName.TaskStarted, task.taskId)
		await vi.advanceTimersByTimeAsync(250)

		expect(seen).toHaveLength(1)
		expect(seen[0].task.state).toBe("running")
		expect(seen[0].task.summary).toBe("working")

		// Same event again without changes → no second push.
		provider.emit(RooCodeEventName.TaskStarted, task.taskId)
		await vi.advanceTimersByTimeAsync(250)
		expect(seen).toHaveLength(1)

		// Task now waits for a tool approval → new status pushed.
		task.taskStatus = TaskStatus.Interactive
		task.taskAsk = makeMessage({ ts: 2, type: "ask", ask: "tool", text: "Run `ls`?" })
		provider.emit(RooCodeEventName.TaskInteractive, task.taskId)
		await vi.advanceTimersByTimeAsync(250)

		expect(seen).toHaveLength(2)
		expect(seen[1].task.state).toBe("waiting_for_input")
		expect(seen[1].task.pendingAsk?.askType).toBe("tool")
	})

	it("streams activity events from the active task and throttles partials per line", async () => {
		const seen: Array<{ ts: number; category: string; partial?: boolean }> = []
		const task = createMockTask({ clineMessages: [] })
		provider.task = task

		bridge.subscribeActivity((payload) => seen.push(payload))
		bridge.start()

		emitMessage(task, makeMessage({ ts: 10, say: "reasoning", text: "step one…", partial: true }))
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ ts: 10, category: "reasoning", partial: true })

		// Second partial for the same line within ~10 Hz window → throttled.
		emitMessage(task, makeMessage({ ts: 10, say: "reasoning", text: "step one, more…", partial: true }))
		expect(seen).toHaveLength(1)

		// After the throttle window elapses → sent again.
		await vi.advanceTimersByTimeAsync(150)
		emitMessage(task, makeMessage({ ts: 10, say: "reasoning", text: "step one, final…", partial: true }))
		expect(seen).toHaveLength(2)

		// The final (non-partial) message is always sent and resets the throttle.
		emitMessage(task, makeMessage({ ts: 10, say: "reasoning", text: "done thinking" }))
		expect(seen).toHaveLength(3)
		expect(seen[2]).toEqual({ ts: 10, kind: "say", category: "reasoning", text: "done thinking" })
	})

	it("filters internal categories in the live stream and only tracks the active task", async () => {
		const seen: Array<{ ts: number; category: string }> = []
		const oldTask = createMockTask({ taskId: "old-task" })
		const newTask = createMockTask({ taskId: "new-task" })
		provider.task = oldTask

		bridge.subscribeActivity((payload) => seen.push(payload))
		bridge.start()

		emitMessage(oldTask, makeMessage({ ts: 1, say: "api_req_started", text: "req" }))
		expect(seen).toHaveLength(0) // filtered category

		// A new task is created → feed tracking switches to it.
		provider.task = newTask
		provider.emit(RooCodeEventName.TaskCreated, newTask as unknown as TaskLike)

		emitMessage(oldTask, makeMessage({ ts: 2, say: "text", text: "from old task" }))
		expect(seen).toHaveLength(0) // no longer tracked

		emitMessage(newTask, makeMessage({ ts: 3, say: "text", text: "from new task" }))
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ ts: 3, category: "text" })
	})

	it("returns the last feed entries for the activity snapshot, honoring the limit", () => {
		const messages: ClineMessage[] = []
		for (let i = 1; i <= 60; i++) {
			messages.push(makeMessage({ ts: i, say: "text", text: `msg ${i}` }))
			if (i % 10 === 0) {
				messages.push(makeMessage({ ts: 1000 + i, say: "checkpoint_saved" as ClineMessage["say"] }))
			}
		}
		const task = createMockTask({ clineMessages: messages })
		provider.task = task

		const all = bridge.getRecentActivity()
		expect(all).toHaveLength(50) // default limit, filtered entries excluded
		expect(all[0].ts).toBe(11) // oldest of the last 50 shown entries
		expect(all.at(-1)?.text).toBe("msg 60")

		const limited = bridge.getRecentActivity(5)
		expect(limited).toHaveLength(5)
		expect(limited.map((entry) => entry.ts)).toEqual([56, 57, 58, 59, 60])
	})

	it("buildStatus reflects the current task state on demand", async () => {
		const task = createMockTask({
			taskStatus: TaskStatus.Interactive,
			taskAsk: makeMessage({ ts: 1, type: "ask", ask: "command", text: "Run `npm test`?" }),
		})
		provider.task = task

		const status = await bridge.buildStatus()
		expect(status.task.state).toBe("waiting_for_input")
		expect(status.task.pendingAsk?.canApprove).toBe(true)
	})

	it("session 9: exposes the extension host workspace in connection.workspace", async () => {
		provider.state.cwd = "/workspaces/zoo-remote"
		const status = await bridge.buildStatus()
		expect(status.connection.workspace).toBe("/workspaces/zoo-remote")

		// No folder open → field omitted (undefined), not an empty string.
		delete provider.state.cwd
		expect((await bridge.buildStatus()).connection.workspace).toBeUndefined()
	})

	it("session 9: emits an activity snapshot when the tracked task switches, but not for the same taskId", () => {
		const snapshots: Array<RemoteActivityPayload[]> = []
		bridge.subscribeActivitySnapshot((payloads) => snapshots.push(payloads))

		const firstTask = createMockTask({
			taskId: "task-a",
			clineMessages: [makeMessage({ ts: 1, say: "text", text: "from a" })],
		})
		const secondTask = createMockTask({
			taskId: "task-b",
			clineMessages: [
				makeMessage({ ts: 2, say: "text", text: "from b" }),
				makeMessage({ ts: 3, say: "text", text: "b again" }),
			],
		})

		// Starting while a task is already tracked → one snapshot of that task's feed (clients
		// replace their accumulated feed with the authoritative history — same as the connect snapshot).
		provider.task = firstTask
		bridge.start()
		expect(snapshots).toHaveLength(1)
		expect(snapshots[0].map((entry) => entry.ts)).toEqual([1])

		// Switch to a different task → snapshot of the new task's feed.
		provider.task = secondTask
		provider.emit(RooCodeEventName.TaskCreated, secondTask as unknown as TaskLike)
		expect(snapshots).toHaveLength(2)
		expect(snapshots[1].map((entry) => entry.ts)).toEqual([2, 3])

		// Re-attaching the same task (rehydration via TaskCreated with the same taskId) → no new snapshot.
		provider.emit(RooCodeEventName.TaskCreated, secondTask as unknown as TaskLike)
		expect(snapshots).toHaveLength(2)
	})
})
