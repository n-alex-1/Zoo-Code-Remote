import https from "https"
import type { Server as HttpsServer, IncomingMessage, ServerResponse } from "http"
import type { Duplex } from "stream"

// `ws` is a CJS module using `export =`: default import = client class, named imports give
// the server classes (namespace members of the exported entity).
import WebSocket, { WebSocketServer } from "ws"

import { extractBearerToken, verifyRemoteToken } from "./RemoteAuth"
import { loadOrCreateCertificate } from "./RemoteCertificate"
import {
	buildAllowedIpSet,
	clientIp,
	isIpAllowed,
	readJsonBody,
	RateLimiter,
	sendActionError,
	sendJson,
	socketIp,
} from "./remoteApi"
import { REMOTE_API_VERSION, REMOTE_DEFAULT_RATE_LIMIT_PER_MINUTE, REMOTE_WS_RATE_LIMIT_PER_MINUTE } from "./types"
import type {
	RemoteActionResult,
	RemoteActivityPayload,
	RemoteCertificateInfo,
	RemoteEvent,
	RemoteServerOptions,
} from "./types"

const WS_PATH = "/events"
const HEALTH_PATH = "/api/health"
const STATUS_PATH = "/api/status"
const MODES_PATH = "/api/modes"
const MODE_PATH = "/api/mode"
const MODELS_PATH = "/api/models"
const MODEL_PATH = "/api/model"
const ASK_RESPOND_PATH = "/api/ask/respond"
/** Max time a WebSocket client has to send its auth frame. */
const WS_AUTH_TIMEOUT_MS = 5_000
/** Keepalive ping interval (matches the API contract). */
const WS_PING_INTERVAL_MS = 30_000

type WsSocket = InstanceType<typeof WebSocket>

/**
 * Thrown when the configured port is already bound. `ownInstance` is true when a probe of
 * `/api/health` on that port answered like another Zoo Remote server (i.e. a second VS Code
 * window) — callers then run in degraded mode (log only, no warning).
 */
export class RemotePortInUseError extends Error {
	constructor(
		readonly ownInstance: boolean,
		readonly port: number,
	) {
		super(
			ownInstance
				? `Remote port ${port} is already used by another Zoo Code window`
				: `Remote port ${port} is already in use by another process`,
		)
		this.name = "RemotePortInUseError"
	}
}

/**
 * Local HTTPS + WebSocket server exposing the Zoo Remote API.
 *
 * - `GET /api/health` — no auth, returns `{ ok: true, version }`.
 * - `GET /api/status` — bearer auth, current `RemoteStatus` (Session 2).
 * - Session 3 actions (all bearer auth, JSON bodies max 16 KB):
 *   `GET /api/modes`, `POST /api/mode {slug}`, `GET /api/models`,
 *   `POST /api/model {profileId, modelId?}`, `POST /api/ask/respond {response, text?}`.
 * - REST routes are rate-limited per client IP (default 60 req/min → 429).
 * - any other route — requires `Authorization: Bearer <token>`, else 401; unknown routes → 404.
 * - `wss://<host>:<port>/events` — first frame must be `{ "auth": "<token>" }`; afterwards the server sends a status snapshot plus an activity snapshot (last ~50 entries), then pushes `status`/`message` events and a keepalive ping every 30 s.
 */
export class RemoteServer {
	private readonly options: RemoteServerOptions
	private server?: HttpsServer
	private wss?: WebSocketServer
	private certificate?: RemoteCertificateInfo
	private clients = new Set<WsSocket>()
	private unsubscribeStatus?: () => void
	private unsubscribeActivity?: () => void
	private readonly rateLimiter: RateLimiter
	/** Handshake limiter for `/events` upgrades (separate budget so one chatty REST peer cannot starve the socket, and vice versa). */
	private readonly wsRateLimiter: RateLimiter
	/** Normalized IP allowlist; empty set = all IPs allowed. Checked at socket level on both REST and WS upgrades. */
	private readonly allowedIps: Set<string>

	constructor(options: RemoteServerOptions) {
		this.options = options
		const limit = options.rateLimitPerMinute ?? REMOTE_DEFAULT_RATE_LIMIT_PER_MINUTE
		this.rateLimiter = new RateLimiter(Number.isFinite(limit) ? limit : REMOTE_DEFAULT_RATE_LIMIT_PER_MINUTE)
		const wsLimit = options.wsRateLimitPerMinute ?? REMOTE_WS_RATE_LIMIT_PER_MINUTE
		this.wsRateLimiter = new RateLimiter(Number.isFinite(wsLimit) ? wsLimit : REMOTE_WS_RATE_LIMIT_PER_MINUTE)
		this.allowedIps = buildAllowedIpSet(options.allowedIps, (line) => this.log(line))
	}

	get isRunning(): boolean {
		return this.server !== undefined
	}

	/** Actual bound port (differs from the configured one only when started on port 0). */
	get port(): number | null {
		if (!this.server) {
			return null
		}
		const address = this.server.address()
		return typeof address === "object" && address ? address.port : null
	}

	get fingerprint(): string | null {
		return this.certificate?.fingerprint ?? null
	}

	async start(): Promise<void> {
		if (this.server) {
			return
		}

		this.log("Starting remote server on port " + this.options.port + "...")
		this.certificate = await loadOrCreateCertificate(this.options.certDir, (line) => this.log(line))

		const token = this.options.token

		const wss = new WebSocketServer({ noServer: true })

		this.server = https.createServer(
			// TLS 1.2 is the contract minimum (docs/architektur.md §1.2); Node's default may be higher, but never lower.
			{ cert: this.certificate.certPem, key: this.certificate.keyPem, minVersion: "TLSv1.2" },
			(req, res) => {
				void this.handleRequest(token, req, res).catch((error) => {
					this.log("Unhandled request error: " + (error instanceof Error ? error.message : String(error)))
					if (!res.headersSent) {
						sendJson(res, 500, { ok: false, error: "internal_error" })
					}
				})
			},
		)

		wss.on("connection", (socket: WsSocket) => {
			this.handleWebSocket(token, socket)
		})
		this.wss = wss

		// Socket-level gate for the WS handshake: path check + IP allowlist + handshake rate limit.
		// (REST keeps working on plain sockets; only /events upgrades to WebSocket.)
		this.server.on("upgrade", (req, socket, head) => {
			const rejectUpgrade = (statusLine: string, reason: string): void => {
				this.log("WS upgrade rejected: " + reason)
				// TLS may still be mid-handshake; a failed write on the destroyed socket must not crash the host.
				socket.on("error", () => undefined)
				socket.write(statusLine + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
				socket.destroy()
			}

			const ip = socketIp(req)
			if ((req.url ?? "").split("?")[0] !== WS_PATH) {
				rejectUpgrade("HTTP/1.1 404 Not Found", "unknown path")
				return
			}
			if (!isIpAllowed(ip, this.allowedIps)) {
				rejectUpgrade("HTTP/1.1 403 Forbidden", "IP not in remote.allowedIps")
				return
			}
			if (!this.wsRateLimiter.allow(ip)) {
				rejectUpgrade("HTTP/1.1 429 Too Many Requests", "handshake rate limit exceeded for IP")
				return
			}
			wss.handleUpgrade(req, socket as unknown as Duplex, head, (ws) => {
				wss.emit("connection", ws, req)
			})
		})

		const statusProvider = this.options.statusProvider
		if (statusProvider) {
			this.unsubscribeStatus = statusProvider.subscribe((status) => {
				for (const client of [...this.clients]) {
					this.sendEvent(client, { type: "status", payload: status })
				}
			})
			this.unsubscribeActivity = statusProvider.subscribeActivity((payload) => {
				for (const client of [...this.clients]) {
					this.sendEvent(client, { type: "message", payload })
				}
			})
		}

		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					reject(error)
				}
				this.server!.once("error", onError)
				this.server!.listen(this.options.port, () => {
					this.server!.off("error", onError)
					resolve()
				})
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
				const ownInstance = await this.probeOwnInstance(this.options.port)
				throw new RemotePortInUseError(ownInstance, this.options.port)
			}
			throw error
		}

		this.log("Remote server listening on https://localhost:" + this.port)
	}

	/**
	 * Checks whether the port that refused our bind is already answered by another Zoo Remote
	 * instance (second VS Code window): `GET /api/health` must return 200 with `{ ok: true }`.
	 * Any other outcome (foreign process, TLS error, timeout) counts as "not ours".
	 */
	private async probeOwnInstance(port: number): Promise<boolean> {
		try {
			const body = await new Promise<string>((resolve, reject) => {
				const request = https.get(
					{
						host: "127.0.0.1",
						port,
						path: HEALTH_PATH,
						method: "GET",
						rejectUnauthorized: false,
						timeout: 1500,
					},
					(response) => {
						if (response.statusCode !== 200) {
							response.resume()
							reject(new Error("status " + response.statusCode))
							return
						}
						let data = ""
						response.setEncoding("utf8")
						response.on("data", (chunk: string) => {
							data += chunk
						})
						response.on("end", () => resolve(data))
					},
				)
				request.on("timeout", () => request.destroy(new Error("probe timeout")))
				request.on("error", reject)
			})
			const parsed = JSON.parse(body) as { ok?: unknown }
			return parsed.ok === true
		} catch {
			return false
		}
	}

	async stop(): Promise<void> {
		const wss = this.wss
		const server = this.server
		if (!server && !wss) {
			return
		}

		this.unsubscribeStatus?.()
		this.unsubscribeActivity?.()
		this.unsubscribeStatus = undefined
		this.unsubscribeActivity = undefined
		this.clients.clear()
		this.server = undefined
		this.wss = undefined

		await new Promise<void>((resolve) => {
			wss?.close()
			server!.close(() => resolve())
			// Close any lingering socket so stop() never hangs.
			server!.closeAllConnections?.()
		})
		this.rateLimiter.dispose()
		this.wsRateLimiter.dispose()
		this.log("Remote server stopped")
	}

	private handleWebSocket(token: string, socket: WsSocket): void {
		let authenticated = false
		const authTimer = setTimeout(() => {
			if (!authenticated) {
				socket.close(4001, "auth timeout")
			}
		}, WS_AUTH_TIMEOUT_MS)

		const pingTimer = setInterval(() => {
			if (authenticated && socket.readyState === WebSocket.OPEN) {
				socket.ping()
			}
		}, WS_PING_INTERVAL_MS)

		socket.on("close", () => {
			clearTimeout(authTimer)
			clearInterval(pingTimer)
			this.clients.delete(socket)
		})

		socket.once("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
			try {
				const parsed = JSON.parse(String(raw)) as { auth?: unknown }
				if (parsed.auth && typeof parsed.auth === "string" && verifyRemoteToken(token, parsed.auth)) {
					authenticated = true
					clearTimeout(authTimer)
					socket.send(JSON.stringify({ type: "connected", version: REMOTE_API_VERSION }))
					this.clients.add(socket)
					void this.sendConnectSnapshots(socket).catch((error) => {
						this.log("WS snapshot error: " + (error instanceof Error ? error.message : String(error)))
					})
				} else {
					socket.close(4002, "unauthorized")
				}
			} catch (error) {
				this.log("WS auth frame parse error: " + (error instanceof Error ? error.message : String(error)))
				socket.close(4003, "bad auth frame")
			}
		})
	}

	private async sendConnectSnapshots(socket: WsSocket): Promise<void> {
		const statusProvider = this.options.statusProvider
		if (!statusProvider) {
			return
		}
		const status = await statusProvider.buildStatus()
		this.sendEvent(socket, { type: "status", payload: status })
		for (const activity of statusProvider.getRecentActivity()) {
			this.sendEvent(socket, { type: "message", payload: activity })
		}
	}

	private sendEvent(socket: WsSocket, event: RemoteEvent): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(event))
		}
	}

	private async handleRequest(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = (req.url ?? "/").split("?")[0]

		// Socket-level allowlist gate for REST (same normalized socket IP as the WS upgrade path).
		if (!isIpAllowed(socketIp(req), this.allowedIps)) {
			sendJson(res, 403, { ok: false, error: "ip_not_allowed" })
			return
		}

		if (url === HEALTH_PATH && req.method === "GET") {
			sendJson(res, 200, { ok: true, version: REMOTE_API_VERSION })
			return
		}

		// Rate limit before auth so a single peer cannot hammer the server.
		if (!this.rateLimiter.allow(clientIp(req))) {
			sendJson(res, 429, { ok: false, error: "rate_limited" })
			return
		}

		const providedToken = extractBearerToken(req.headers.authorization)
		if (!verifyRemoteToken(token, providedToken)) {
			res.setHeader("WWW-Authenticate", "Bearer")
			sendJson(res, 401, { ok: false, error: "unauthorized" })
			return
		}

		const method = req.method ?? "GET"

		if (url === STATUS_PATH && method === "GET") {
			const statusProvider = this.options.statusProvider
			if (!statusProvider) {
				sendJson(res, 503, { ok: false, error: "bridge_not_ready" })
				return
			}
			const status = await statusProvider.buildStatus()
			sendJson(res, 200, status as unknown as Record<string, unknown>)
			return
		}

		if (url === MODES_PATH && method === "GET") {
			await this.handleListModes(req, res)
			return
		}

		if (url === MODE_PATH && method === "POST") {
			await this.handleSetMode(req, res)
			return
		}

		if (url === MODELS_PATH && method === "GET") {
			await this.handleListModels(req, res)
			return
		}

		if (url === MODEL_PATH && method === "POST") {
			await this.handleSetModel(req, res)
			return
		}

		if (url === ASK_RESPOND_PATH && method === "POST") {
			await this.handleAskRespond(req, res)
			return
		}

		sendJson(res, 404, { ok: false, error: "not_found", path: url })
	}

	private requireActions(res: ServerResponse): boolean {
		if (!this.options.actionProvider) {
			sendJson(res, 503, { ok: false, error: "actions_not_ready" })
			return false
		}
		return true
	}

	private async handleListModes(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.requireActions(res)) {
			return
		}
		const result = await this.options.actionProvider!.listModes()
		if (result.ok) {
			sendJson(res, 200, { modes: result.modes })
		} else {
			sendActionError(res, result.error)
		}
		void req
	}

	private async handleListModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.requireActions(res)) {
			return
		}
		const result = await this.options.actionProvider!.listModels()
		if (result.ok) {
			sendJson(res, 200, { profiles: result.profiles, currentModel: result.currentModel })
		} else {
			sendActionError(res, result.error)
		}
		void req
	}

	private async handleSetMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.requireActions(res)) {
			return
		}
		const parsed = await readJsonBody(req)
		if (!parsed.ok) {
			sendJson(res, 400, { ok: false, error: parsed.error })
			return
		}
		const slug = parsed.value.slug
		if (typeof slug !== "string" || !slug.trim()) {
			sendJson(res, 400, { ok: false, error: "invalid_body" })
			return
		}
		const result = await this.options.actionProvider!.setMode(slug)
		await this.finishAction(res, result)
	}

	private async handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.requireActions(res)) {
			return
		}
		const parsed = await readJsonBody(req)
		if (!parsed.ok) {
			sendJson(res, 400, { ok: false, error: parsed.error })
			return
		}
		const profileId = parsed.value.profileId
		const modelId = parsed.value.modelId
		if (
			typeof profileId !== "string" ||
			!profileId.trim() ||
			(modelId !== undefined && typeof modelId !== "string")
		) {
			sendJson(res, 400, { ok: false, error: "invalid_body" })
			return
		}
		const result = await this.options.actionProvider!.setModel(profileId, modelId)
		await this.finishAction(res, result)
	}

	private async handleAskRespond(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.requireActions(res)) {
			return
		}
		const parsed = await readJsonBody(req)
		if (!parsed.ok) {
			sendJson(res, 400, { ok: false, error: parsed.error })
			return
		}
		const response = parsed.value.response
		const text = parsed.value.text
		const validResponses = ["yesButtonClicked", "noButtonClicked", "messageResponse"] as const
		if (
			!validResponses.includes(response as (typeof validResponses)[number]) ||
			(text !== undefined && typeof text !== "string")
		) {
			sendJson(res, 400, { ok: false, error: "invalid_body" })
			return
		}
		const result = await this.options.actionProvider!.respondToAsk(
			response as (typeof validResponses)[number],
			text,
		)
		await this.finishAction(res, result)
	}

	/** Successful actions answer with the fresh `RemoteStatus` (contract); falls back to `{ ok: true }`. */
	private async finishAction(res: ServerResponse, result: RemoteActionResult): Promise<void> {
		if (!result.ok) {
			sendActionError(res, result.error ?? "action_failed")
			return
		}
		const statusProvider = this.options.statusProvider
		if (statusProvider) {
			try {
				const status = await statusProvider.buildStatus()
				sendJson(res, 200, status as unknown as Record<string, unknown>)
				return
			} catch (error) {
				this.log(
					"Failed to build post-action status: " + (error instanceof Error ? error.message : String(error)),
				)
			}
		}
		sendJson(res, 200, { ok: true })
	}

	private log(line: string): void {
		this.options.log?.("[Zoo Remote] " + line)
	}
}
