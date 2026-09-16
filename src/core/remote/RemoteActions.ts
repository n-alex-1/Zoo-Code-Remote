import { spawn } from "child_process"
import type { Dirent, Stats } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

import * as vscode from "vscode"

import { getModelId, modelIdKeysByProvider, TaskStatus } from "@roo-code/types"
import type { HistoryItem, ProviderSettings, ProviderSettingsWithId } from "@roo-code/types"

import { getModeBySlug } from "../../shared/modes"
import type { ClineProvider } from "../webview/ClineProvider"

import type {
	ModeInfo,
	ProfileInfo,
	RemoteActionResult,
	RemoteAskResponse,
	RemoteModelsResponse,
	RemoteTaskInfo,
	RemoteWorkspaceInfo,
} from "./types"

/** Valid values for `POST /api/ask/respond` (contract: docs/architektur.md §3). */
const VALID_ASK_RESPONSES: readonly RemoteAskResponse[] = [
	"yesButtonClicked",
	"noButtonClicked",
	"messageResponse",
] as const

/** Session 9 contract limits. */
const MAX_TASK_HISTORY_ENTRIES = 50
const TASK_TITLE_MAX_CHARS = 200
const MAX_WORKSPACES = 10
const WORKSPACE_PATH_MAX_CHARS = 400

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Truncates a task title for the remote contract (max {@link TASK_TITLE_MAX_CHARS}). */
function truncateTaskTitle(task: string | undefined): string {
	const value = (task ?? "").trim()
	return value.length > TASK_TITLE_MAX_CHARS ? value.slice(0, TASK_TITLE_MAX_CHARS - 1) + "…" : value
}

/** Maps a `HistoryItem` to the slender `RemoteTaskInfo` contract shape. */
function mapHistoryItem(item: HistoryItem): RemoteTaskInfo {
	const info: RemoteTaskInfo = {
		taskId: item.id,
		ts: item.ts,
		task: truncateTaskTitle(item.task),
	}
	if (item.mode) {
		info.mode = item.mode
	}
	if (item.status) {
		info.status = item.status
	}
	if (item.workspace) {
		info.workspace = item.workspace
	}
	return info
}

/** Parses one `workspaceStorage/<id>/workspace.json` into a workspace entry. */
function parseWorkspaceFile(content: string): RemoteWorkspaceInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(content)
		if (typeof parsed !== "object" || parsed === null) {
			return undefined
		}
		const record = parsed as Record<string, unknown>
		const folder = typeof record.folder === "string" ? record.folder : ""
		if (!folder.startsWith("file://")) {
			return undefined
		}
		let decoded: string
		try {
			decoded = decodeURIComponent(folder.slice("file://".length))
		} catch {
			decoded = folder.slice("file://".length)
		}
		if (!decoded || decoded.length > WORKSPACE_PATH_MAX_CHARS) {
			return undefined
		}
		const info: RemoteWorkspaceInfo = { path: decoded }
		if (typeof record.name === "string" && record.name.trim()) {
			info.name = record.name.trim()
		}
		return info
	} catch {
		return undefined
	}
}

/**
 * Recently used workspaces from the VS Code user-data dir (session 9): scans all
 * `<userData>/workspaceStorage/<id>/workspace.json` files, sorts by file mtime (newest first)
 * and deduplicates identical paths. `maxEntries` caps the result; failures are non-fatal.
 */
async function listRecentWorkspaces(
	userDataDir: string | undefined,
	maxEntries: number = MAX_WORKSPACES,
): Promise<RemoteWorkspaceInfo[]> {
	if (!userDataDir) {
		return []
	}
	const storageRoot = path.join(userDataDir, "workspaceStorage")
	let dirEntries: Dirent[]
	try {
		dirEntries = await fs.readdir(storageRoot, { withFileTypes: true })
	} catch {
		return []
	}

	const candidates: Array<{ info: RemoteWorkspaceInfo; mtimeMs: number }> = []
	for (const entry of dirEntries) {
		if (!entry.isDirectory()) {
			continue
		}
		let stat: Stats
		try {
			stat = await fs.stat(path.join(storageRoot, entry.name, "workspace.json"))
		} catch {
			continue // no workspace.json → not a folder workspace (or empty)
		}
		let content: string
		try {
			content = await fs.readFile(path.join(storageRoot, entry.name, "workspace.json"), "utf8")
		} catch {
			continue
		}
		const info = parseWorkspaceFile(content)
		if (info) {
			candidates.push({ info, mtimeMs: stat.mtimeMs })
		}
	}

	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
	const seen = new Set<string>()
	const result: RemoteWorkspaceInfo[] = []
	for (const candidate of candidates) {
		if (seen.has(candidate.info.path)) {
			continue
		}
		seen.add(candidate.info.path)
		result.push(candidate.info)
		if (result.length >= maxEntries) {
			break
		}
	}
	return result
}

/** Resolves the VS Code user-data directory for workspace scanning. */
function userDataDirForWorkspaces(): string | undefined {
	try {
		const env = vscode.env as unknown as { appData?: string }
		if (typeof env.appData === "string" && env.appData) {
			return env.appData
		}
	} catch {
		// fall through to the platform default below
	}
	switch (process.platform) {
		case "win32":
			return process.env.APPDATA ? path.join(process.env.APPDATA, "Code", "User") : undefined
		case "darwin":
			return path.join(os.homedir(), "Library", "Application Support", "Code", "User")
		default:
			return path.join(os.homedir(), ".config", "Code", "User")
	}
}

/**
 * Action layer of the remote API (Session 3).
 *
 * Reuses the exact same code paths as the webview — no parallel implementation:
 * - respondToAsk → `Task.handleWebviewAskResponse` / `approveAsk` / `denyAsk`
 *   (the `askResponse` case of `webviewMessageHandler`).
 * - setMode → `ClineProvider.handleModeSwitch` (the `mode` case).
 * - listModels/setModel → `providerSettingsManager.listConfig/getProfile/saveConfig`
 *   + `ClineProvider.activateProviderProfile` (the profile cases).
 *
 * All methods are exception-safe: they return `{ ok, error? }` instead of throwing.
 */
export class RemoteActions {
	private readonly provider: ClineProvider
	private readonly log?: (line: string) => void

	constructor(provider: ClineProvider, log?: (line: string) => void) {
		this.provider = provider
		this.log = log
	}

	/**
	 * Respond to the active task's pending ask.
	 * Errors: `invalid_response`, `no_active_task`, `no_pending_ask`, `text_required`.
	 *
	 * Session 9: `messageResponse` also works **without** a pending ask as long as an active task
	 * exists — it routes exactly like the webview's free-text input (ChatView.handleSendMessage):
	 * - pending ask              → answered via handleWebviewAskResponse
	 * - running / queue draining → pushed into task.messageQueueService, so multiple remote
	 *                              inputs keep their order and are processed as separate turns
	 * - idle (completed/error)   → continues/queues the same session via handleWebviewAskResponse
	 * `no_pending_ask` therefore only applies to yes/no button responses.
	 */
	async respondToAsk(response: RemoteAskResponse, text?: string): Promise<RemoteActionResult> {
		try {
			if (!VALID_ASK_RESPONSES.includes(response)) {
				return { ok: false, error: "invalid_response" }
			}

			const task = this.provider.getCurrentTask()
			if (!task) {
				return { ok: false, error: "no_active_task" }
			}

			const ask = task.taskAsk
			const hasPendingAsk = ask?.type === "ask"

			if (response !== "messageResponse" && !hasPendingAsk) {
				return { ok: false, error: "no_pending_ask" }
			}

			if (response === "messageResponse") {
				const trimmed = typeof text === "string" ? text.trim() : ""
				if (!trimmed) {
					return { ok: false, error: "text_required" }
				}
				this.deliverMessageResponse(task, hasPendingAsk, trimmed)
			} else if (response === "yesButtonClicked") {
				// Same path as the webview's yes button (TaskLike.approveAsk → handleWebviewAskResponse).
				task.approveAsk({})
			} else {
				task.denyAsk({})
			}

			return { ok: true }
		} catch (error) {
			this.log?.("respondToAsk failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/**
	 * Routes a free-text `messageResponse` like the webview does (ChatView.handleSendMessage):
	 * while the task is running — or its message queue is still draining — the text goes into
	 * `task.messageQueueService`, which the Task drains in order after tool results / asks.
	 * Everything else answers/continues via handleWebviewAskResponse.
	 */
	private deliverMessageResponse(
		task: NonNullable<ReturnType<ClineProvider["getCurrentTask"]>>,
		hasPendingAsk: boolean,
		text: string,
	): void {
		const queuedCount = (task as { queuedMessages?: unknown[] }).queuedMessages?.length ?? 0

		if (!hasPendingAsk && (task.taskStatus === TaskStatus.Running || queuedCount > 0)) {
			const queueService = (task as { messageQueueService?: { addMessage(text: string): void } })
				.messageQueueService
			if (queueService) {
				queueService.addMessage(text)
				return
			}
		}

		task.handleWebviewAskResponse("messageResponse", text)
	}

	/**
	 * Switch the active mode by slug (built-in or custom).
	 * Errors: `invalid_slug`, `unknown_mode`.
	 */
	async setMode(slug: string): Promise<RemoteActionResult> {
		try {
			if (typeof slug !== "string" || !slug.trim()) {
				return { ok: false, error: "invalid_slug" }
			}

			const customModes = await this.provider.customModesManager.getCustomModes()
			if (!getModeBySlug(slug, customModes)) {
				return { ok: false, error: "unknown_mode" }
			}

			// Same path as the webview's `mode` message.
			await this.provider.handleModeSwitch(slug)
			return { ok: true }
		} catch (error) {
			this.log?.("setMode failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/** All modes incl. custom modes (`ClineProvider.getModes`). */
	async listModes(): Promise<{ ok: true; modes: ModeInfo[] } | { ok: false; error: string }> {
		try {
			const modes = await this.provider.getModes()
			return { ok: true, modes: modes.map(({ slug, name }) => ({ slug, name })) }
		} catch (error) {
			this.log?.("listModes failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/** Provider profiles plus the currently active model (`GET /api/models` payload). */
	async listModels(): Promise<({ ok: true } & RemoteModelsResponse) | { ok: false; error: string }> {
		try {
			const entries = await this.provider.providerSettingsManager.listConfig()
			const profiles: ProfileInfo[] = entries.map((entry) => ({
				id: entry.id,
				name: entry.name,
				provider: entry.apiProvider,
				modelId: entry.modelId,
			}))

			const state = await this.provider.getStateToPostToWebview({ includeTaskHistory: false })
			const currentModel = getModelId((state.apiConfiguration ?? {}) as ProviderSettings) ?? ""

			return { ok: true, profiles, currentModel }
		} catch (error) {
			this.log?.("listModels failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/**
	 * Activate a provider profile by its `id` (or name), optionally overriding the model.
	 * Errors: `invalid_profile_id`, `unknown_profile`, `unknown_provider`, `unknown_model_field`.
	 */
	async setModel(profileId: string, modelId?: string): Promise<RemoteActionResult> {
		try {
			if (typeof profileId !== "string" || !profileId.trim()) {
				return { ok: false, error: "invalid_profile_id" }
			}

			const entries = await this.provider.providerSettingsManager.listConfig()
			const entry = entries.find((candidate) => candidate.id === profileId || candidate.name === profileId)
			if (!entry) {
				return { ok: false, error: "unknown_profile" }
			}

			const trimmedModel = typeof modelId === "string" ? modelId.trim() : ""
			if (trimmedModel && trimmedModel !== entry.modelId) {
				const full = await this.provider.providerSettingsManager.getProfile({ id: entry.id })
				if (!full.apiProvider) {
					return { ok: false, error: "unknown_provider" }
				}

				// The model lives in a provider-specific field (e.g. `apiModelId`); the registry maps it per provider.
				const modelKey = (modelIdKeysByProvider as Record<string, string | undefined>)[full.apiProvider]
				if (!modelKey) {
					return { ok: false, error: "unknown_model_field" }
				}

				await this.provider.providerSettingsManager.saveConfig(entry.name, {
					...full,
					[modelKey]: trimmedModel,
				})
			}

			// Same path as the webview's profile switch (also rebuilds the task API handler + emits ProviderProfileChanged).
			await this.provider.activateProviderProfile({ name: entry.name })
			return { ok: true }
		} catch (error) {
			this.log?.("setModel failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/* ------------------------------------------------------------------ *
	 * Session 9 — task history & workspaces.
	 * ------------------------------------------------------------------ */

	/**
	 * Task history for the app's session picker (`GET /api/tasks`): newest first, capped at
	 * {@link MAX_TASK_HISTORY_ENTRIES}. Same source as the webview's history list
	 * (`taskHistoryStore.getAll()`, filtered/sorted like `broadcastTaskHistoryUpdate`).
	 *
	 * With [workspace] only entries whose `workspace` matches exactly are returned — the same
	 * comparison the webview uses for its own list (`getRecentTasks`: `item.workspace === this.cwd`)
	 * — so opening a session always happens in its original workspace context. Without it the
	 * global history (all workspaces) is served, newest first.
	 */
	async listTasks(workspace?: string): Promise<{ ok: true; tasks: RemoteTaskInfo[] } | { ok: false; error: string }> {
		try {
			await this.provider.taskHistoryStore.initialized
			const normalized = typeof workspace === "string" ? workspace.trim() : ""
			let items = this.provider.taskHistoryStore.getAll().filter((item) => item.ts && item.task)
			if (normalized) {
				items = items.filter((item) => item.workspace === normalized)
			}
			const tasks = items
				.sort((a, b) => b.ts - a.ts)
				.slice(0, MAX_TASK_HISTORY_ENTRIES)
				.map(mapHistoryItem)
			return { ok: true, tasks }
		} catch (error) {
			this.log?.("listTasks failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/**
	 * Starts a new session/task with the given text (`POST /api/task/start`) — same path as the
	 * webview's `newTask` message. A previous task is evicted by `createTask` itself (single-open-task
	 * invariant), matching what happens when the user starts a fresh chat in VS Code.
	 * Errors: `invalid_text`.
	 */
	async startTask(text: string): Promise<RemoteActionResult> {
		try {
			const trimmed = typeof text === "string" ? text.trim() : ""
			if (!trimmed) {
				return { ok: false, error: "invalid_text" }
			}

			await this.provider.createTask(trimmed, undefined, undefined, {})
			return { ok: true }
		} catch (error) {
			this.log?.("startTask failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/**
	 * Restores an older session from history (`POST /api/task/open`) — same path as the webview's
	 * history click (`showTaskWithId`). Errors: `invalid_task_id`, `unknown_task`.
	 */
	async openTask(taskId: string): Promise<RemoteActionResult> {
		try {
			const trimmed = typeof taskId === "string" ? taskId.trim() : ""
			if (!trimmed) {
				return { ok: false, error: "invalid_task_id" }
			}

			await this.provider.showTaskWithId(trimmed)
			return { ok: true }
		} catch (error) {
			const message = errorMessage(error)
			this.log?.("openTask failed: " + message)
			return { ok: false, error: /not found/i.test(message) ? "unknown_task" : message }
		}
	}

	/**
	 * Stops the current task (`POST /api/task/cancel`) — same path as the webview's cancel button.
	 * Errors: `no_active_task`.
	 */
	async cancelTask(): Promise<RemoteActionResult> {
		try {
			const task = this.provider.getCurrentTask()
			if (!task) {
				return { ok: false, error: "no_active_task" }
			}

			await this.provider.cancelTask()
			return { ok: true }
		} catch (error) {
			this.log?.("cancelTask failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/**
	 * Recently used workspaces (`GET /api/workspaces`) — scanned from the VS Code user-data dir.
	 */
	async listWorkspaces(): Promise<{ ok: true; workspaces: RemoteWorkspaceInfo[] } | { ok: false; error: string }> {
		try {
			const workspaces = await listRecentWorkspaces(userDataDirForWorkspaces(), MAX_WORKSPACES)
			return { ok: true, workspaces }
		} catch (error) {
			this.log?.("listWorkspaces failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}

	/**
	 * Opens a workspace in a new VS Code window (`POST /api/workspace/open`) via the `code` CLI.
	 * Errors: `invalid_path`, `code_cli_failed`.
	 */
	async openWorkspace(workspacePath: string): Promise<RemoteActionResult> {
		try {
			const trimmed = typeof workspacePath === "string" ? workspacePath.trim() : ""
			if (!trimmed || trimmed.length > WORKSPACE_PATH_MAX_CHARS) {
				return { ok: false, error: "invalid_path" }
			}

			await new Promise<void>((resolve, reject) => {
				const child = spawnCode(trimmed)
				child.once("error", (error) => reject(error))
				child.once("spawn", () => resolve())
			})
			return { ok: true }
		} catch (error) {
			this.log?.("openWorkspace failed: " + errorMessage(error))
			return { ok: false, error: "code_cli_failed" }
		}
	}
}

/**
 * Spawns the `code` CLI detached so a new VS Code window opens for [workspacePath]. The child is
 * unref'ed — it must not keep the extension host alive. Errors (ENOENT, spawn failure) are reported
 * via the "error" event; a successful spawn resolves immediately even though `code` may still be running.
 */
function spawnCode(workspacePath: string): import("child_process").ChildProcess {
	const command = process.platform === "win32" ? "code.cmd" : "code"
	const child = spawn(command, [workspacePath], { detached: true, stdio: "ignore", windowsHide: true })
	child.unref()
	return child
}
