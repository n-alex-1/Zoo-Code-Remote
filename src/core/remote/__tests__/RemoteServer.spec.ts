import fs from "fs/promises"
import https from "node:https"
import os from "os"
import path from "path"

import WebSocket from "ws"

import { providerIdentifiers } from "@roo-code/types"

import { allowNetConnect } from "../../../vitest.setup"

import { extractBearerToken, generateRemoteToken, verifyRemoteToken } from "../RemoteAuth"
import { computeFingerprint, loadOrCreateCertificate } from "../RemoteCertificate"
import { RemoteServer } from "../RemoteServer"
import type { RemoteActionSource, RemoteActivityPayload, RemoteStatus } from "../types"

/** Fetch helper that accepts self-signed certificates (node:https supports rejectUnauthorized). */
function fetchJson(
	url: string,
	init?: { headers?: Record<string, string> },
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies are arbitrary in tests
): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { rejectUnauthorized: false, headers: init?.headers }, (response) => {
			let data = ""
			response.setEncoding("utf8")
			response.on("data", (chunk: string) => {
				data += chunk
			})
			response.on("end", () => {
				let body: unknown
				try {
					body = JSON.parse(data)
				} catch {
					body = data
				}
				resolve({ status: response.statusCode ?? 0, body })
			})
		})
		request.on("error", reject)
	})
}

/** Connects to the WS endpoint and resolves once the socket is open. */
function connectRemoteSocket(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`wss://localhost:${port}/events`, { rejectUnauthorized: false })
		socket.once("open", () => resolve(socket))
		socket.once("error", (error) => reject(error))
	})
}

interface WsFrame {
	type: string
	payload?: Record<string, unknown> & { ts?: number; task?: { state: string } }
}

describe("RemoteAuth", () => {
	it("generates a 64-char hex token", () => {
		const token = generateRemoteToken()
		expect(token).toMatch(/^[0-9a-f]{64}$/)
	})

	it("verifies matching tokens and rejects mismatches", () => {
		const token = generateRemoteToken()
		expect(verifyRemoteToken(token, token)).toBe(true)
		expect(verifyRemoteToken(token, "other")).toBe(false)
		expect(verifyRemoteToken(null, token)).toBe(false)
		expect(verifyRemoteToken(token, undefined)).toBe(false)
	})

	it("extracts the bearer token from an Authorization header", () => {
		const token = generateRemoteToken()
		expect(extractBearerToken(`Bearer ${token}`)).toBe(token)
		expect(extractBearerToken(`bearer ${token}`)).toBe(token)
		expect(extractBearerToken(undefined)).toBeNull()
		expect(extractBearerToken("Basic abc")).toBeNull()
	})
})

describe("RemoteCertificate", () => {
	it("creates a certificate once and reuses it on subsequent loads", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-cert-"))
		try {
			const first = await loadOrCreateCertificate(dir)
			expect(first.certPem).toContain("BEGIN CERTIFICATE")
			expect(first.keyPem).toContain("PRIVATE KEY")
			expect(first.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/)

			const second = await loadOrCreateCertificate(dir)
			expect(second.certPem).toBe(first.certPem)
			expect(second.fingerprint).toBe(first.fingerprint)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("computes a stable SHA-256 fingerprint for the same PEM", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-fp-"))
		try {
			const cert = await loadOrCreateCertificate(dir)
			expect(computeFingerprint(cert.certPem)).toBe(cert.fingerprint)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("RemoteServer", () => {
	// The tests talk to a real local HTTPS/WebSocket server on an ephemeral port.
	beforeAll(() => {
		allowNetConnect("localhost")
	})

	let server: RemoteServer
	let token: string
	let certDir: string

	beforeEach(async () => {
		token = generateRemoteToken()
		certDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-server-"))
		server = new RemoteServer({ port: 0, token, certDir }) // port 0 → free port chosen by the OS
		await server.start()
	})

	afterEach(async () => {
		await server.stop()
		await fs.rm(certDir, { recursive: true, force: true })
	})

	it("answers GET /api/health without auth", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/health`)
		expect(status).toBe(200)
		expect(body).toEqual({ ok: true, version: "1" })
	})

	it("returns 401 for other routes without a token", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/status`)
		expect(status).toBe(401)
		expect(body.ok).toBe(false)
	})

	it("returns 401 for other routes with a wrong token", async () => {
		const { status } = await fetchJson(`https://localhost:${server.port}/api/status`, {
			headers: { Authorization: `Bearer ${generateRemoteToken()}` },
		})
		expect(status).toBe(401)
	})

	it("returns 404 for unknown routes with a valid token", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/nope`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(404)
		expect(body.ok).toBe(false)
	})

	/** Connects to the WS endpoint and resolves once the socket is open. */
	function connectRemoteSocket(port: number): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(`wss://localhost:${port}/events`, { rejectUnauthorized: false })
			socket.once("open", () => resolve(socket))
			socket.once("error", (error) => reject(error))
		})
	}

	it("authenticates WebSocket clients via the first frame and answers with connected", async () => {
		const socket = await connectRemoteSocket(server.port as number)
		let unexpectedError: Error | undefined
		socket.on("error", (error) => {
			unexpectedError = error
		})

		const firstMessagePromise = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout waiting for WS message")), 5000)
			socket.once("message", (raw) => {
				clearTimeout(timer)
				resolve(String(raw))
			})
		})

		socket.send(JSON.stringify({ auth: token }))
		const firstMessage = await firstMessagePromise
		expect(unexpectedError).toBeUndefined()

		expect(JSON.parse(firstMessage)).toEqual({ type: "connected", version: "1" })

		await new Promise<void>((resolve) => {
			socket.once("close", () => resolve())
			socket.close()
		})
	})

	it("closes WebSocket clients that send a wrong auth frame", async () => {
		const socket = await connectRemoteSocket(server.port as number)

		const closeCodePromise = new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout waiting for WS close")), 5000)
			socket.once("close", (code) => {
				clearTimeout(timer)
				resolve(code)
			})
		})

		socket.send(JSON.stringify({ auth: generateRemoteToken() }))
		const closeCode = await closeCodePromise

		expect(closeCode).toBe(4002)
	})

	it("reports running state and a stable fingerprint while started", async () => {
		expect(server.isRunning).toBe(true)
		expect(typeof server.port).toBe("number")
		expect(server.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/)

		await server.stop()
		expect(server.isRunning).toBe(false)
		expect(server.port).toBeNull()
	})
})

describe("RemoteServer with status bridge (Session 2)", () => {
	beforeAll(() => {
		allowNetConnect("localhost")
	})

	const fakeStatus: RemoteStatus = {
		connection: { extensionVersion: "9.9.9-test", apiVersion: "1" },
		task: { state: "idle" as const },
		mode: { current: "code", label: "💻 Code" },
		model: {
			profileName: "default",
			modelId: "claude-sonnet-4-5",
			provider: providerIdentifiers.anthropic,
		},
	}

	function createMockBridge() {
		const statusListeners = new Set<(status: RemoteStatus) => void>()
		const activityListeners = new Set<(payload: RemoteActivityPayload) => void>()
		const recentActivity: RemoteActivityPayload[] = [
			{ ts: 1, kind: "say", category: "text", text: "hello" },
			{ ts: 2, kind: "ask", category: "tool", answered: false },
		]
		return {
			buildStatus: async () => fakeStatus,
			getRecentActivity: () => recentActivity,
			subscribe(listener: (status: RemoteStatus) => void) {
				statusListeners.add(listener)
				return () => statusListeners.delete(listener)
			},
			subscribeActivity(listener: (payload: RemoteActivityPayload) => void) {
				activityListeners.add(listener)
				return () => activityListeners.delete(listener)
			},
			emitStatus(status: RemoteStatus = fakeStatus) {
				for (const listener of statusListeners) {
					listener(status)
				}
			},
			emitActivity(payload: RemoteActivityPayload) {
				for (const listener of activityListeners) {
					listener(payload)
				}
			},
		}
	}

	let server: RemoteServer
	let token: string
	let certDir: string
	let bridge: ReturnType<typeof createMockBridge>

	beforeEach(async () => {
		token = generateRemoteToken()
		certDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-server2-"))
		bridge = createMockBridge()
		server = new RemoteServer({ port: 0, token, certDir, statusProvider: bridge })
		await server.start()
	})

	afterEach(async () => {
		await server.stop()
		await fs.rm(certDir, { recursive: true, force: true })
	})

	it("serves GET /api/status with the current RemoteStatus", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/status`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(200)
		expect(body).toEqual(fakeStatus)
	})

	it("returns 401 for GET /api/status without a token", async () => {
		const { status } = await fetchJson(`https://localhost:${server.port}/api/status`)
		expect(status).toBe(401)
	})

	it("sends status + activity snapshots after WS auth, then live events", async () => {
		const socket = await connectRemoteSocket(server.port as number)
		socket.on("error", () => undefined) // keepalive pings may surface errors on close

		const received: WsFrame[] = []
		socket.on("message", (raw) => {
			received.push(JSON.parse(String(raw)) as WsFrame)
		})

		socket.send(JSON.stringify({ auth: token }))

		await waitFor(() => received.length >= 3, "snapshot frames")
		expect(received[0]).toEqual({ type: "connected", version: "1" })
		expect(received[1]).toEqual({ type: "status", payload: fakeStatus })
		expect(received[2]?.type).toBe("message")
		expect(received[2]?.payload?.ts).toBe(1)
		expect(received[3]?.type).toBe("message")

		// Live push after connect.
		bridge.emitStatus({ ...fakeStatus, task: { state: "running" } })
		await waitFor(() => received.length >= 5, "live status event")
		const live = received[4]
		expect(live.type).toBe("status")
		expect(live.payload?.task?.state).toBe("running")

		await new Promise<void>((resolve) => {
			socket.once("close", () => resolve())
			socket.close()
		})
	})
})

describe("RemoteServer actions (Session 3)", () => {
	beforeAll(() => {
		allowNetConnect("localhost")
	})

	const fakeStatus: RemoteStatus = {
		connection: { extensionVersion: "9.9.9-test", apiVersion: "1" },
		task: { state: "waiting_for_input", pendingAsk: { askType: "tool", canApprove: true, expectsText: false } },
		mode: { current: "code", label: "💻 Code" },
		model: { profileName: "default", modelId: "claude-sonnet-4-5", provider: providerIdentifiers.anthropic },
	}

	function createMockActions(overrides: Partial<RemoteActionSource> = {}): RemoteActionSource {
		return {
			respondToAsk: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			setMode: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			listModes: async () => ({
				ok: true as const,
				modes: [{ slug: "code", name: "💻 Code" }, { slug: "ask", name: "❓ Ask" }],
			}),
			listModels: async () => ({
				ok: true as const,
				profiles: [
					{ id: "profile-a", name: "default", provider: providerIdentifiers.anthropic, modelId: "claude-sonnet-4-5" },
				],
				currentModel: "claude-sonnet-4-5",
			}),
			setModel: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			...overrides,
		}
	}

	function createMockBridge() {
		return {
			buildStatus: async () => fakeStatus,
			getRecentActivity: () => [] as RemoteActivityPayload[],
			subscribe() {
				return () => undefined
			},
			subscribeActivity() {
				return () => undefined
			},
		}
	}

	/** POST helper that accepts self-signed certificates. */
	function postJson(
		url: string,
		body: unknown,
		headers?: Record<string, string>,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies are arbitrary in tests
	): Promise<{ status: number; body: any }> {
		return new Promise((resolve, reject) => {
			const request = https.request(url, { method: "POST", rejectUnauthorized: false, headers: { "Content-Type": "application/json", ...headers } }, (response) => {
				let data = ""
				response.setEncoding("utf8")
				response.on("data", (chunk: string) => {
					data += chunk
				})
				response.on("end", () => {
					let parsed: unknown
					try {
						parsed = JSON.parse(data)
					} catch {
						parsed = data
					}
					resolve({ status: response.statusCode ?? 0, body: parsed })
				})
			})
			request.on("error", reject)
			request.end(JSON.stringify(body))
		})
	}

	let server: RemoteServer
	let token: string
	let certDir: string
	let actions: ReturnType<typeof createMockActions>

	beforeEach(async () => {
		token = generateRemoteToken()
		certDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-server3-"))
		actions = createMockActions()
		server = new RemoteServer({ port: 0, token, certDir, statusProvider: createMockBridge(), actionProvider: actions })
		await server.start()
	})

	afterEach(async () => {
		await server.stop()
		await fs.rm(certDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("serves GET /api/modes", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/modes`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(200)
		expect(body.modes).toEqual([{ slug: "code", name: "💻 Code" }, { slug: "ask", name: "❓ Ask" }])
	})

	it("serves GET /api/models with profiles and currentModel", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/models`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(200)
		expect(body.currentModel).toBe("claude-sonnet-4-5")
		expect(Array.isArray(body.profiles)).toBe(true)
		expect(body.profiles[0]).toMatchObject({ id: "profile-a", name: "default" })
	})

	it("POST /api/mode calls setMode and answers with the fresh status", async () => {
		const { status, body } = await postJson(`https://localhost:${server.port}/api/mode`, { slug: "ask" }, {
			Authorization: `Bearer ${token}`,
		})
		expect(status).toBe(200)
		expect(actions.setMode).toHaveBeenCalledWith("ask")
		expect(body).toEqual(fakeStatus)
	})

	it("POST /api/mode with an invalid body answers 400", async () => {
		const { status, body } = await postJson(`https://localhost:${server.port}/api/mode`, { nope: true }, {
			Authorization: `Bearer ${token}`,
		})
		expect(status).toBe(400)
		expect(body.error).toBe("invalid_body")
		expect(actions.setMode).not.toHaveBeenCalled()
	})

	it("POST /api/model calls setModel and answers with the fresh status", async () => {
		const { status, body } = await postJson(`https://localhost:${server.port}/api/model`, { profileId: "profile-a" }, {
			Authorization: `Bearer ${token}`,
		})
		expect(status).toBe(200)
		expect(actions.setModel).toHaveBeenCalledWith("profile-a", undefined)
		expect(body).toEqual(fakeStatus)
	})

	it("POST /api/model forwards the optional modelId", async () => {
		await postJson(`https://localhost:${server.port}/api/model`, { profileId: "profile-a", modelId: "claude-opus-4" }, {
			Authorization: `Bearer ${token}`,
		})
		expect(actions.setModel).toHaveBeenCalledWith("profile-a", "claude-opus-4")
	})

	it("POST /api/ask/respond calls respondToAsk and answers with the fresh status", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/ask/respond`,
			{ response: "yesButtonClicked" },
			{ Authorization: `Bearer ${token}` },
		)
		expect(status).toBe(200)
		expect(actions.respondToAsk).toHaveBeenCalledWith("yesButtonClicked", undefined)
		expect(body).toEqual(fakeStatus)
	})

	it("POST /api/ask/respond forwards text for messageResponse", async () => {
		await postJson(`https://localhost:${server.port}/api/ask/respond`, { response: "messageResponse", text: "go" }, {
			Authorization: `Bearer ${token}`,
		})
		expect(actions.respondToAsk).toHaveBeenCalledWith("messageResponse", "go")
	})

	it("answers 409 when respondToAsk reports no pending ask", async () => {
		const actionsNoAsk = createMockActions({ respondToAsk: vi.fn(async () => ({ ok: false, error: "no_pending_ask" })) })
		server = new RemoteServer({ port: 0, token, certDir, statusProvider: createMockBridge(), actionProvider: actionsNoAsk })
		await server.start()

		const { status, body } = await postJson(`https://localhost:${server.port}/api/ask/respond`, { response: "yesButtonClicked" }, {
			Authorization: `Bearer ${token}`,
		})
		expect(status).toBe(409)
		expect(body.error).toBe("no_pending_ask")

		await server.stop()
	})

	it("answers 400 for action failures other than pending-ask conflicts", async () => {
		const actionsBad = createMockActions({ setMode: vi.fn(async () => ({ ok: false, error: "unknown_mode" })) })
		server = new RemoteServer({ port: 0, token, certDir, statusProvider: createMockBridge(), actionProvider: actionsBad })
		await server.start()

		const { status, body } = await postJson(`https://localhost:${server.port}/api/mode`, { slug: "nope" }, {
			Authorization: `Bearer ${token}`,
		})
		expect(status).toBe(400)
		expect(body.error).toBe("unknown_mode")

		await server.stop()
	})

	it("answers 401 for action routes without a token", async () => {
		const { status } = await fetchJson(`https://localhost:${server.port}/api/modes`)
		expect(status).toBe(401)
		const postStatus = (await postJson(`https://localhost:${server.port}/api/ask/respond`, { response: "yesButtonClicked" })).status
		expect(postStatus).toBe(401)
	})

	it("answers 503 for action routes when no action provider is wired", async () => {
		const bare = new RemoteServer({ port: 0, token, certDir, statusProvider: createMockBridge() })
		await bare.start()
		try {
			const { status } = await fetchJson(`https://localhost:${bare.port}/api/modes`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(status).toBe(503)
		} finally {
			await bare.stop()
		}
	})

	it("rejects bodies over 16 KB with 400 body_too_large", async () => {
		const big = { slug: "code", padding: "x".repeat(17 * 1024) }
		const { status, body } = await postJson(`https://localhost:${server.port}/api/mode`, big, {
			Authorization: `Bearer ${token}`,
		})
		expect(status).toBe(400)
		expect(body.error).toBe("body_too_large")
		expect(actions.setMode).not.toHaveBeenCalled()
	})

	it("rejects invalid JSON with 400 invalid_json", async () => {
		return new Promise<void>((resolve, reject) => {
			const request = https.request(
				`https://localhost:${server.port}/api/mode`,
				{ method: "POST", rejectUnauthorized: false, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } },
				(response) => {
					let data = ""
					response.setEncoding("utf8")
					response.on("data", (chunk: string) => (data += chunk))
					response.on("end", () => {
						expect(response.statusCode).toBe(400)
						expect(JSON.parse(data)).toEqual({ ok: false, error: "invalid_json" })
						resolve()
					})
				},
			)
			request.on("error", reject)
			request.end("{ not json")
		})
	})

	it("rate-limits REST requests per IP (429 after the limit)", async () => {
		const limited = new RemoteServer({
			port: 0,
			token,
			certDir,
			statusProvider: createMockBridge(),
			actionProvider: actions,
			rateLimitPerMinute: 3,
		})
		await limited.start()
		try {
			const headers = { Authorization: `Bearer ${token}` }
			expect((await fetchJson(`https://localhost:${limited.port}/api/status`, { headers })).status).toBe(200)
			expect((await fetchJson(`https://localhost:${limited.port}/api/status`, { headers })).status).toBe(200)
			expect((await fetchJson(`https://localhost:${limited.port}/api/status`, { headers })).status).toBe(200)
			const limitedResponse = await fetchJson(`https://localhost:${limited.port}/api/status`, { headers })
			expect(limitedResponse.status).toBe(429)
			expect(limitedResponse.body.error).toBe("rate_limited")
		} finally {
			await limited.stop()
		}
	})
})

/** Resolves once the predicate holds or fails after a timeout. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const started = Date.now()
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			throw new Error("timeout waiting for " + what)
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}
