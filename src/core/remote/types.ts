import type {
	ClineMessage,
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

/** Default port, chosen to avoid well-known dev/service ports. */
export const REMOTE_DEFAULT_PORT = 8999

export const REMOTE_MIN_PORT = 1024
export const REMOTE_MAX_PORT = 65535

/** SecretStorage key for the bearer token (per extension host). */
export const REMOTE_TOKEN_SECRET_KEY = "zooRemote.token"

/** VS Code configuration keys (contributes.configuration in src/package.json). */
export const REMOTE_ENABLED_SETTING = "remote.enabled" as const
export const REMOTE_PORT_SETTING = "remote.port" as const

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
}

/** Minimal surface of the state bridge (RemoteStateBridge) that the server needs. Declared structurally so tests can use plain mocks. */
export interface RemoteStatusProvider {
	buildStatus(): Promise<RemoteStatus>
	getRecentActivity(limit?: number): RemoteActivityPayload[]
	subscribe(listener: (status: RemoteStatus) => void): () => void
	subscribeActivity(listener: (payload: RemoteActivityPayload) => void): () => void
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
	connection: { extensionVersion: string; apiVersion: typeof REMOTE_API_VERSION }
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
export type RemoteActionResult<T = undefined> = T extends undefined ? { ok: boolean; error?: string } : { ok: true } & T | { ok: false; error: string }

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
	/** Respond to the active task's pending ask (webview `askResponse` path). 409-like failure when no ask is pending. */
	respondToAsk(response: RemoteAskResponse, text?: string): Promise<RemoteActionResult>
	/** Switch mode by slug (webview `mode` path). Failure for unknown slugs. */
	setMode(slug: string): Promise<RemoteActionResult>
	/** All modes incl. custom modes. */
	listModes(): Promise<{ ok: true; modes: ModeInfo[] } | { ok: false; error: string }>
	/** Provider profiles with current model info (see RemoteModelsResponse). */
	listModels(): Promise<{ ok: true } & RemoteModelsResponse | { ok: false; error: string }>
	/** Activate a provider profile by id, optionally overriding the model. Failure for unknown ids. */
	setModel(profileId: string, modelId?: string): Promise<RemoteActionResult>
}

export type { ClineMessage, TaskStatus }
