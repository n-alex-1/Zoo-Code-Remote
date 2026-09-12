import type {
	ClineMessage,
	HistoryItem,
	ModelInfo,
	ProviderSettingsEntry,
	TaskEvents,
	TaskLike,
	TaskProviderEvents,
	TaskStatus,
} from "@roo-code/types"

/**
 * Remote Control — shared types for the local HTTPS/WebSocket server that
 * lets the "Zoo Remote" Android app see status and send actions.
 *
 * See docs/architektur.md (API-Vertrag) in the zoo-remote workspace.
 */

export const REMOTE_API_VERSION = "1"

/** Default rate limit for REST routes: requests per minute per client IP. */
export const REMOTE_DEFAULT_RATE_LIMIT_PER_MINUTE = 60

/** Default rate limit for WebSocket handshakes on `/events`: connections per minute per client IP. */
export const REMOTE_WS_RATE_LIMIT_PER_MINUTE = 30

/** Default port, chosen to avoid well-known dev/service ports. */
export const REMOTE_DEFAULT_PORT = 8999

export const REMOTE_MIN_PORT = 1024
export const REMOTE_MAX_PORT = 65535

/** SecretStorage key for the bearer token (per extension host). */
export const REMOTE_TOKEN_SECRET_KEY = "zooRemote.token"

/** VS Code configuration keys (contributes.configuration in src/package.json). */
export const REMOTE_ENABLED_SETTING = "remote.enabled" as const
export const REMOTE_PORT_SETTING = "remote.port" as const
export const REMOTE_ALLOWED_IPS_SETTING = "remote.allowedIps" as const

export interface RemoteServerOptions {
	/** TCP port to listen on. */
	port: number
	/** Bearer token required for all routes except /api/health and the WS auth frame. */
	token: string
	/** Directory where the self-signed certificate is created/persisted (globalStorageUri/remote). */
	certDir: string
	/** Optional logger (defaults to console.log-free no-op). */
	log?: (line: string) => void
	/** Status/activity source (Session 2). When absent, `GET /api/status` answers 503 and the WS sends no snapshots. */
	statusProvider?: RemoteStatusProvider
	/** Action source (Session 3). When absent, action routes answer 503. */
	actionProvider?: RemoteActionSource
	/** Rate limit for REST routes: requests per minute per client IP (default {@link REMOTE_DEFAULT_RATE_LIMIT_PER_MINUTE}). Set to `0`/negative to disable. */
	rateLimitPerMinute?: number
	/** Optional allowlist of client IPs (IPv4 or IPv6, exact match after normalization). Empty/undefined = all IPs allowed. Applied at socket level on REST and WS upgrades alike. */
	allowedIps?: string[]
	/** Rate limit for WebSocket handshakes on `/events`: connections per minute per client IP (default {@link REMOTE_WS_RATE_LIMIT_PER_MINUTE}). Set to `0`/negative to disable. */
	wsRateLimitPerMinute?: number
}

/** Minimal surface of the state bridge (RemoteStateBridge) that the server needs. Declared structurally so tests can use plain mocks. */
export interface RemoteStatusProvider {
	buildStatus(): Promise<RemoteStatus>
	getRecentActivity(limit?: number): RemoteActivityPayload[]
	subscribe(listener: (status: RemoteStatus) => void): () => void
	subscribeActivity(listener: (payload: RemoteActivityPayload) => void): () => void
	/** Fired with the active task's recent feed entries when its tracked task switches to a different taskId. */
	subscribeActivitySnapshot?(listener: (payloads: RemoteActivityPayload[]) => void): () => void
}

export interface RemoteCertificateInfo {
	certPem: string
	keyPem: string
	/** SHA-256 fingerprint of the certificate, hex, colon-separated. */
	fingerprint: string
}

/** Payload for the webview message `remoteInfo` (extension → webview). */
export interface RemoteInfoPayload {
	enabled: boolean
	port: number
	running: boolean
	token: string | null
	fingerprint: string | null
}

/* ------------------------------------------------------------------ *
 * API contract (docs/architektur.md §3) — shared with the Android app.
 * Keep in sync with the Kotlin data classes of the remote app.
 * ------------------------------------------------------------------ */

export type RemoteTaskState = "idle" | "running" | "waiting_for_input" | "completed" | "error"

/** `GET /api/status` response and payload of WS `status` events. */
export interface RemoteStatus {
	connection: {
		extensionVersion: string
		apiVersion: typeof REMOTE_API_VERSION
		/** Workspace folder of the extension host (its `cwd`); undefined when no folder is open. */
		workspace?: string
	}
	task: {
		state: RemoteTaskState
		taskId?: string
		summary?: string
		contextWindow?: { used: number; limit?: number; percent?: number }
		pendingAsk?: {
			askType: string
			question?: string
			canApprove: boolean
			expectsText: boolean
			suggestions?: RemoteSuggestion[]
		}
	}
	mode: { current: string; label: string }
	model: { profileName?: string; modelId?: string; provider?: string }
}

/** Follow-up answer suggestion — parsed server-side from the `followup` ask text (same JSON shape as the webview). */
export interface RemoteSuggestion {
	/** Suggested reply, max 200 chars. Tapping it in the app = `messageResponse` with this text. */
	answer: string
	/** Optional target mode slug; only set when it is a known default or custom mode. */
	mode?: string
}

/**
 * Slender ClineMessage extract for the app's chat feed (no HTML, no raw tool output).
 * Payload of WS `message` events. Identity is `ts`: a payload with `partial: true`
 * and an already-seen `ts` replaces that line (streaming), a new `ts` appends.
 */
export interface RemoteActivityPayload {
	ts: number
	kind: "say" | "ask"
	category: string
	text?: string
	partial?: boolean
	/** Only for kind="ask": whether the ask has been answered already. */
	answered?: boolean
}

/** Server → client frames on `wss://<host>:<port>/events`. */
export type RemoteEvent =
	| { type: "status"; payload: RemoteStatus }
	| { type: "message"; payload: RemoteActivityPayload }
	/**
	 * Replaces the app's whole activity feed with the given entries (the history of the active
	 * task). Sent on connect and whenever the plugin switches to a different task, so switching
	 * sessions from the app shows the right content without a reconnect.
	 */
	| { type: "activity_snapshot"; payload: RemoteActivityPayload[] }
	| { type: "ping" }

/** `GET /api/modes` response. */
export interface ModeInfo {
	slug: string
	name: string
}

/** `GET /api/models` — one provider profile entry (see ProviderSettingsEntry). */
export interface ProfileInfo extends Pick<ProviderSettingsEntry, "id" | "name"> {
	provider?: string
	modelId?: string
}

/** `GET /api/models` response. */
export interface RemoteModelsResponse {
	profiles: ProfileInfo[]
	currentModel: string
}

/* ------------------------------------------------------------------ *
 * Session 9 — task history & recently used workspaces (contract §3).
 * ------------------------------------------------------------------ */

/** One entry of the task history (`GET /api/tasks`) — a slender subset of `HistoryItem`. */
export interface RemoteTaskInfo {
	/** HistoryItem.id. */
	taskId: string
	/** Start timestamp (ms) — list is sorted descending. */
	ts: number
	/** Task title, truncated to 200 chars. */
	task: string
	mode?: string
	status?: "active" | "completed" | "delegated" | "interrupted"
	workspace?: string
}

/** `GET /api/tasks` response — newest first, max 50 entries. */
export interface RemoteTasksResponse {
	tasks: RemoteTaskInfo[]
}

/** A recently used VS Code workspace (`GET /api/workspaces`). */
export interface RemoteWorkspaceInfo {
	/** Workspace/project folder path (for `code <path>`). */
	path: string
	name?: string
}

/** `GET /api/workspaces` response — newest first, max 10 entries. */
export interface RemoteWorkspacesResponse {
	workspaces: RemoteWorkspaceInfo[]
}

/** Body of `POST /api/task/start`. */
export interface RemoteTaskStartCommand {
	text: string
}

/** Body of `POST /api/task/open`. */
export interface RemoteTaskOpenCommand {
	taskId: string
}

/** Body of `POST /api/workspace/open`. */
export interface RemoteWorkspaceOpenCommand {
	path: string
}

/* ------------------------------------------------------------------ *
 * Action routes (Session 3) — request/response shapes of the contract.
 * ------------------------------------------------------------------ */

/** Valid values for `POST /api/ask/respond` body `response`. */
export type RemoteAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

/** Body of `POST /api/mode`. */
export interface RemoteModeCommand {
	slug: string
}

/** Body of `POST /api/model`. `modelId` is optional (profile switch only). */
export interface RemoteModelCommand {
	profileId: string
	modelId?: string
}

/** Body of `POST /api/ask/respond`. `text` is required for `messageResponse`. */
export interface RemoteAskRespondCommand {
	response: RemoteAskResponse
	text?: string
}

/** Result object returned by {@link RemoteActionSource} methods (no exceptions leak). */
export type RemoteActionResult<T = undefined> = T extends undefined
	? { ok: boolean; error?: string }
	: ({ ok: true } & T) | { ok: false; error: string }

/* ------------------------------------------------------------------ *
 * Structural source interfaces — the minimal surface of ClineProvider /
 * Task that the RemoteStateBridge reads. Declared structurally (instead of
 * importing those classes) so unit tests can use plain mocks and to avoid
 * pulling the whole extension into the remote module graph.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Structural source interfaces — the minimal surface of ClineProvider /
 * Task that the RemoteStateBridge reads. Declared structurally (instead of
 * importing those classes) so unit tests can use plain mocks and to avoid
 * pulling the whole extension into the remote module graph.
 * ------------------------------------------------------------------ */

/** The subset of ExtensionState the bridge needs (see ClineProvider.getStateToPostToWebview). */
export interface RemoteStateSource {
	version: string
	mode: string
	/** Workspace folder of the extension host (mirrors `ExtensionState.cwd`). */
	cwd?: string
	customModes?: Array<{ slug: string; name: string }>
	currentApiConfigName?: string
	apiConfiguration?: { apiProvider?: string } & Record<string, unknown>
}

/** The subset of Task the bridge reads (TaskLike + clineMessages, which is public on Task). */
export interface RemoteTaskSource extends Pick<TaskLike, "taskId" | "taskStatus" | "taskAsk" | "tokenUsage"> {
	readonly abort: boolean
	readonly abandoned: boolean
	readonly clineMessages: ClineMessage[]
	/** Optional access to the current model metadata (structural subset of `Task.api` / ApiHandler) — used for the context-window limit. */
	readonly api?: { getModel(): { id: string; info: ModelInfo } } | undefined
	on<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this
	off<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this
}

/** The subset of ClineProvider the bridge listens to / queries. */
export interface RemoteEventSource {
	getCurrentTask(): RemoteTaskSource | undefined
	getStateToPostToWebview(options?: { includeTaskHistory?: boolean }): Promise<RemoteStateSource>
	on<K extends keyof TaskProviderEvents>(event: K, listener: (...args: TaskProviderEvents[K]) => void): this
	off<K extends keyof TaskProviderEvents>(event: K, listener: (...args: TaskProviderEvents[K]) => void): this
}

/**
 * Structural surface of the action layer (RemoteActions) that the server needs.
 * Declared structurally so tests can use plain mocks. All methods must not throw;
 * they report failures via `{ ok: false, error }`.
 */
export interface RemoteActionSource {
	/**
	 * Respond to the active task's pending ask (webview `askResponse` path). 409-like failure when no ask is pending.
	 * Session 9: `messageResponse` also works without a pending ask as long as an active task exists — it continues/queues
	 * into the same session, exactly like the webview's free-text input (Task.ts message queue / follow-up handling).
	 */
	respondToAsk(response: RemoteAskResponse, text?: string): Promise<RemoteActionResult>
	/** Switch mode by slug (webview `mode` path). Failure for unknown slugs. */
	setMode(slug: string): Promise<RemoteActionResult>
	/** All modes incl. custom modes. */
	listModes(): Promise<{ ok: true; modes: ModeInfo[] } | { ok: false; error: string }>
	/** Provider profiles with current model info (see RemoteModelsResponse). */
	listModels(): Promise<({ ok: true } & RemoteModelsResponse) | { ok: false; error: string }>
	/** Activate a provider profile by id, optionally overriding the model. Failure for unknown ids. */
	setModel(profileId: string, modelId?: string): Promise<RemoteActionResult>
	/**
	 * Task history, newest first (session 9). Without [workspace] the global history is returned
	 * (all workspaces); with it only entries whose `workspace` matches exactly — same comparison as
	 * the webview's own history list (`getRecentTasks`).
	 */
	listTasks(workspace?: string): Promise<{ ok: true; tasks: RemoteTaskInfo[] } | { ok: false; error: string }>
	/** Start a new task/session with the given text (webview `newTask` path). Failure when no text. */
	startTask(text: string): Promise<RemoteActionResult>
	/** Restore an older session from history by id (webview history-click / showTaskWithId path). */
	openTask(taskId: string): Promise<RemoteActionResult>
	/** Stop the current task (`cancelTask`, same path as the webview). Failure when no active task. */
	cancelTask(): Promise<RemoteActionResult>
	/** Recently used workspaces, newest first (session 9). */
	listWorkspaces(): Promise<{ ok: true; workspaces: RemoteWorkspaceInfo[] } | { ok: false; error: string }>
	/** Open a workspace in a new VS Code window (`code <path>`). Failure when the path is invalid. */
	openWorkspace(workspacePath: string): Promise<RemoteActionResult>
}

export type { ClineMessage, TaskStatus }
