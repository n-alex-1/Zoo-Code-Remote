import fs from "fs/promises"
import https from "node:https"
import os from "os"
import path from "path"

import WebSocket from "ws"

import { providerIdentifiers } from "@roo-code/types"

import { allowNetConnect } from "../../../vitest.setup"

import { extractBearerToken, generateRemoteToken, verifyRemoteToken } from "../RemoteAuth"
import { computeFingerprint, isValidCertificatePair, loadOrCreateCertificate } from "../RemoteCertificate"
import { buildAllowedIpSet, isIpAllowed, normalizeClientIp } from "../remoteApi"
import { RemotePortInUseError, RemoteServer } from "../RemoteServer"
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

	function createMockActions(
		overrides: Partial<RemoteActionSource> = {},
	): RemoteActionSource & { listTasksCalls: Array<[string?]> } {
		const listTasks = vi.fn(async (workspace?: string) => ({
			ok: true as const,
			tasks: workspace
				? [{ taskId: "task-1", ts: 1000, task: `Session one in ${workspace}` }]
				: [{ taskId: "task-1", ts: 1000, task: "Session one" }],
		}))
		return {
			listTasksCalls: listTasks.mock.calls as Array<[string?]>,
			respondToAsk: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			setMode: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			// Session 9 surfaces.
			listTasks,
			startTask: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			openTask: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			cancelTask: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			listWorkspaces: async () => ({
				ok: true as const,
				workspaces: [{ path: "/tmp/project", name: "Project" }],
			}),
			openWorkspace: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
			listModes: async () => ({
				ok: true as const,
				modes: [
					{ slug: "code", name: "💻 Code" },
					{ slug: "ask", name: "❓ Ask" },
				],
			}),
			listModels: async () => ({
				ok: true as const,
				profiles: [
					{
						id: "profile-a",
						name: "default",
						provider: providerIdentifiers.anthropic,
						modelId: "claude-sonnet-4-5",
					},
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
			const request = https.request(
				url,
				{
					method: "POST",
					rejectUnauthorized: false,
					headers: { "Content-Type": "application/json", ...headers },
				},
				(response) => {
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
				},
			)
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
		server = new RemoteServer({
			port: 0,
			token,
			certDir,
			statusProvider: createMockBridge(),
			actionProvider: actions,
		})
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
		expect(body.modes).toEqual([
			{ slug: "code", name: "💻 Code" },
			{ slug: "ask", name: "❓ Ask" },
		])
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
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/mode`,
			{ slug: "ask" },
			{
				Authorization: `Bearer ${token}`,
			},
		)
		expect(status).toBe(200)
		expect(actions.setMode).toHaveBeenCalledWith("ask")
		expect(body).toEqual(fakeStatus)
	})

	it("POST /api/mode with an invalid body answers 400", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/mode`,
			{ nope: true },
			{
				Authorization: `Bearer ${token}`,
			},
		)
		expect(status).toBe(400)
		expect(body.error).toBe("invalid_body")
		expect(actions.setMode).not.toHaveBeenCalled()
	})

	it("POST /api/model calls setModel and answers with the fresh status", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/model`,
			{ profileId: "profile-a" },
			{
				Authorization: `Bearer ${token}`,
			},
		)
		expect(status).toBe(200)
		expect(actions.setModel).toHaveBeenCalledWith("profile-a", undefined)
		expect(body).toEqual(fakeStatus)
	})

	it("POST /api/model forwards the optional modelId", async () => {
		await postJson(
			`https://localhost:${server.port}/api/model`,
			{ profileId: "profile-a", modelId: "claude-opus-4" },
			{
				Authorization: `Bearer ${token}`,
			},
		)
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
		await postJson(
			`https://localhost:${server.port}/api/ask/respond`,
			{ response: "messageResponse", text: "go" },
			{
				Authorization: `Bearer ${token}`,
			},
		)
		expect(actions.respondToAsk).toHaveBeenCalledWith("messageResponse", "go")
	})

	it("answers 409 when respondToAsk reports no pending ask", async () => {
		const actionsNoAsk = createMockActions({
			respondToAsk: vi.fn(async () => ({ ok: false, error: "no_pending_ask" })),
		})
		server = new RemoteServer({
			port: 0,
			token,
			certDir,
			statusProvider: createMockBridge(),
			actionProvider: actionsNoAsk,
		})
		await server.start()

		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/ask/respond`,
			{ response: "yesButtonClicked" },
			{
				Authorization: `Bearer ${token}`,
			},
		)
		expect(status).toBe(409)
		expect(body.error).toBe("no_pending_ask")

		await server.stop()
	})

	it("answers 400 for action failures other than pending-ask conflicts", async () => {
		const actionsBad = createMockActions({ setMode: vi.fn(async () => ({ ok: false, error: "unknown_mode" })) })
		server = new RemoteServer({
			port: 0,
			token,
			certDir,
			statusProvider: createMockBridge(),
			actionProvider: actionsBad,
		})
		await server.start()

		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/mode`,
			{ slug: "nope" },
			{
				Authorization: `Bearer ${token}`,
			},
		)
		expect(status).toBe(400)
		expect(body.error).toBe("unknown_mode")

		await server.stop()
	})

	it("answers 401 for action routes without a token", async () => {
		const { status } = await fetchJson(`https://localhost:${server.port}/api/modes`)
		expect(status).toBe(401)
		const postStatus = (
			await postJson(`https://localhost:${server.port}/api/ask/respond`, { response: "yesButtonClicked" })
		).status
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
				{
					method: "POST",
					rejectUnauthorized: false,
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				},
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

	it("session 9: serves GET /api/tasks", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/tasks`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(200)
		expect(body.tasks).toEqual([{ taskId: "task-1", ts: 1000, task: "Session one" }])
		expect(actions.listTasksCalls.at(-1)).toEqual([undefined])
	})

	it("session 9: forwards the ?workspace= filter of GET /api/tasks (decoded)", async () => {
		const encoded = encodeURIComponent("/tmp/project with space")
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/tasks?workspace=${encoded}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(200)
		expect(actions.listTasksCalls.at(-1)).toEqual(["/tmp/project with space"])
		expect(body.tasks[0].task).toContain("/tmp/project with space")

		// Blank parameter = no filtering.
		await fetchJson(`https://localhost:${server.port}/api/tasks?workspace=%20%20`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(actions.listTasksCalls.at(-1)).toEqual([undefined])
	})

	it("session 9: POST /api/task/start calls startTask and answers with the fresh status", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/task/start`,
			{ text: "build me a thing" },
			{ Authorization: `Bearer ${token}` },
		)
		expect(status).toBe(200)
		expect(actions.startTask).toHaveBeenCalledWith("build me a thing")
		expect(body).toEqual(fakeStatus)
	})

	it("session 9: POST /api/task/start with an empty text answers 400", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/task/start`,
			{ text: "   " },
			{ Authorization: `Bearer ${token}` },
		)
		expect(status).toBe(400)
		expect(body.error).toBe("invalid_body")
		expect(actions.startTask).not.toHaveBeenCalled()
	})

	it("session 9: POST /api/task/open calls openTask and answers with the fresh status", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/task/open`,
			{ taskId: "task-1" },
			{ Authorization: `Bearer ${token}` },
		)
		expect(status).toBe(200)
		expect(actions.openTask).toHaveBeenCalledWith("task-1")
		expect(body).toEqual(fakeStatus)
	})

	it("session 9: POST /api/task/cancel works with an empty body", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/task/cancel`,
			{},
			{ Authorization: `Bearer ${token}` },
		)
		expect(status).toBe(200)
		expect(actions.cancelTask).toHaveBeenCalledTimes(1)
		expect(body).toEqual(fakeStatus)
	})

	it("session 9: serves GET /api/workspaces", async () => {
		const { status, body } = await fetchJson(`https://localhost:${server.port}/api/workspaces`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(status).toBe(200)
		expect(body.workspaces).toEqual([{ path: "/tmp/project", name: "Project" }])
	})

	it("session 9: POST /api/workspace/open calls openWorkspace and answers with the fresh status", async () => {
		const { status, body } = await postJson(
			`https://localhost:${server.port}/api/workspace/open`,
			{ path: "/tmp/project" },
			{ Authorization: `Bearer ${token}` },
		)
		expect(status).toBe(200)
		expect(actions.openWorkspace).toHaveBeenCalledWith("/tmp/project")
		expect(body).toEqual(fakeStatus)
	})

	it("session 9: task/workspace routes require auth and answer 401 without a token", async () => {
		expect((await fetchJson(`https://localhost:${server.port}/api/tasks`)).status).toBe(401)
		expect((await fetchJson(`https://localhost:${server.port}/api/workspaces`)).status).toBe(401)
		const postStatus = (await postJson(`https://localhost:${server.port}/api/task/cancel`, {})).status
		expect(postStatus).toBe(401)
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

describe("Session 8a — IP normalization & allowlist (unit)", () => {
	it("normalizes IPv4 and rejects non-literals", () => {
		expect(normalizeClientIp("192.168.1.7")).toBe("192.168.1.7")
		expect(normalizeClientIp("unknown")).toBeUndefined()
		expect(normalizeClientIp("  ")).toBeUndefined()
	})

	it("normalizes IPv6: expands ::, lowercases, strips zone ids", () => {
		expect(normalizeClientIp("::1")).toBe("0:0:0:0:0:0:0:1")
		expect(normalizeClientIp("2001:DB8::1")).toBe("2001:db8:0:0:0:0:0:1")
		expect(normalizeClientIp("fe80::1%eth0")).toBe("fe80:0:0:0:0:0:0:1")
	})

	it("normalizes IPv4-mapped IPv6 to the embedded IPv4 address", () => {
		// Node reports loopback peers as ::ffff:127.0.0.1 (e.g. under nock's mock sockets) —
		// allowlist entries like "127.0.0.1" must still match them.
		expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1")
		expect(normalizeClientIp("::FFFF:192.168.2.3")).toBe("192.168.2.3")
		const set = buildAllowedIpSet(["127.0.0.1"])
		expect(isIpAllowed("::ffff:127.0.0.1", set)).toBe(true)
	})

	it("builds the allowlist set and drops invalid entries", () => {
		const logs: string[] = []
		const set = buildAllowedIpSet(["192.168.1.7", "::1", "not-an-ip", ""], (line) => logs.push(line))
		expect(set.has("192.168.1.7")).toBe(true)
		expect(set.has("0:0:0:0:0:0:0:1")).toBe(true)
		expect(set.size).toBe(2)
		expect(logs.some((line) => line.includes("not-an-ip"))).toBe(true)

		// empty/absent list = all allowed
		expect(isIpAllowed("8.8.8.8", new Set())).toBe(true)
	})

	it("checks IPs against the allowlist (both loopback spellings)", () => {
		const set = buildAllowedIpSet(["::1"])
		expect(isIpAllowed("127.0.0.1", set)).toBe(false)
		expect(isIpAllowed("::1", set)).toBe(true)
		expect(isIpAllowed("fe80::1%eth0", set)).toBe(false)
	})
})

describe("Session 8a — Härtung (integration)", () => {
	beforeAll(() => {
		// nock matches against "host:port/path" — keep the prefix form.
		allowNetConnect(/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/)
	})

	let token: string
	let certDir: string

	beforeEach(async () => {
		token = generateRemoteToken()
		certDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-hardening-"))
	})

	afterEach(async () => {
		await fs.rm(certDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("keeps the bearer token out of all log lines (401 + 200 traffic)", async () => {
		const logs: string[] = []
		const server = new RemoteServer({ port: 0, token, certDir, log: (line) => logs.push(line) })
		await server.start()
		try {
			const headers = { Authorization: `Bearer ${token}` }
			await fetchJson(`https://127.0.0.1:${server.port}/api/status`) // 401 path
			await fetchJson(`https://127.0.0.1:${server.port}/api/health`, { headers }) // 200 path
		} finally {
			await server.stop()
		}
		expect(logs.length).toBeGreaterThan(0)
		for (const line of logs) {
			expect(line).not.toContain(token)
		}
	})

	it("rejects REST and WS from IPs outside remote.allowedIps, accepts listed ones", async () => {
		const rejected = new RemoteServer({ port: 0, token, certDir, allowedIps: ["192.0.2.7"] })
		await rejected.start()
		try {
			const health = await fetchJson(`https://127.0.0.1:${rejected.port}/api/health`)
			expect(health.status).toBe(403)
			expect(health.body.error).toBe("ip_not_allowed")

			const status = await fetchJson(`https://127.0.0.1:${rejected.port}/api/status`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(status.status).toBe(403)

			// WS upgrade from 127.0.0.1 must also be refused (socket-level gate).
			const wsError = await new Promise<string>((resolve, reject) => {
				const socket = new WebSocket(`wss://127.0.0.1:${rejected.port}/events`, { rejectUnauthorized: false })
				socket.once("open", () => resolve("unexpectedly opened"))
				socket.once("error", (error) => resolve(error.message))
			})
			expect(wsError).not.toBe("unexpectedly opened")
		} finally {
			await rejected.stop()
		}

		const allowed = new RemoteServer({ port: 0, token, certDir, allowedIps: ["127.0.0.1"] })
		await allowed.start()
		try {
			expect((await fetchJson(`https://127.0.0.1:${allowed.port}/api/health`)).status).toBe(200)
			const socket = new WebSocket(`wss://127.0.0.1:${allowed.port}/events`, { rejectUnauthorized: false })
			await new Promise<void>((resolve, reject) => {
				socket.once("open", () => resolve())
				socket.once("error", (error) => reject(error))
			})
			socket.close()
		} finally {
			await allowed.stop()
		}
	})

	it("rate-limits WebSocket handshakes per IP (429 after the limit)", async () => {
		const limited = new RemoteServer({ port: 0, token, certDir, wsRateLimitPerMinute: 2 })
		await limited.start()
		try {
			const connectOnce = (expectOpen: boolean) =>
				new Promise<boolean>((resolve) => {
					const socket = new WebSocket(`wss://127.0.0.1:${limited.port}/events`, {
						rejectUnauthorized: false,
					})
					socket.once("open", () => {
						socket.close()
						resolve(expectOpen ? true : false)
					})
					socket.once("error", () => resolve(expectOpen ? false : true))
				})

			expect(await connectOnce(true)).toBe(true) // 1st handshake allowed
			expect(await connectOnce(true)).toBe(true) // 2nd handshake allowed
			expect(await connectOnce(false)).toBe(true) // 3rd rejected (429 → socket destroyed)
		} finally {
			await limited.stop()
		}
	})

	it("enforces TLS >= 1.2 (a client capped at TLS 1.1 fails the handshake)", async () => {
		const server = new RemoteServer({ port: 0, token, certDir })
		await server.start()
		try {
			const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
				const request = https.get(
					{
						host: "127.0.0.1",
						port: server.port as number,
						path: "/api/health",
						rejectUnauthorized: false,
						maxVersion: "TLSv1.1",
					},
					(response) => {
						response.resume()
						resolve({ ok: true }) // unexpected: handshake succeeded with < TLS 1.2
					},
				)
				request.once("error", (error) => resolve({ ok: false, error: error.message }))
			})
			expect(result.ok).toBe(false)

			// And a normal client still connects fine.
			const healthy = await fetchJson(`https://127.0.0.1:${server.port}/api/health`)
			expect(healthy.status).toBe(200)
		} finally {
			await server.stop()
		}
	})

	it("regenerates a corrupt certificate pair instead of failing", async () => {
		const first = await loadOrCreateCertificate(certDir)
		expect(isValidCertificatePair(first.certPem, first.keyPem)).toBe(true)

		// Corrupt the stored files (truncated cert + mismatched key).
		await fs.writeFile(path.join(certDir, "remote-cert.pem"), "-----BEGIN CERTIFICATE-----\nabc\n")
		const regenerated = await loadOrCreateCertificate(certDir)
		expect(isValidCertificatePair(regenerated.certPem, regenerated.keyPem)).toBe(true)
		expect(regenerated.fingerprint).not.toBe(first.fingerprint)

		// A server can start with the regenerated pair.
		const server = new RemoteServer({ port: 0, token, certDir })
		await server.start()
		try {
			expect(server.fingerprint).toBe(regenerated.fingerprint)
		} finally {
			await server.stop()
		}
	})

	it("detects EADDRINUSE and distinguishes own instance (degraded mode) from foreign processes", async () => {
		const first = new RemoteServer({ port: 0, token, certDir })
		await first.start()
		const port = first.port as number

		try {
			// Same Zoo Remote server on the same port → ownInstance=true (degraded mode).
			const second = new RemoteServer({ port, token, certDir: path.join(certDir, "second") })
			let ownError: unknown
			try {
				await second.start()
			} catch (error) {
				ownError = error
			}
			expect(ownError).toBeInstanceOf(RemotePortInUseError)
			expect((ownError as RemotePortInUseError).ownInstance).toBe(true)

			// Free the port again, then occupy it with a foreign (non-Zoo-Remote) HTTPS process → ownInstance=false.
			await first.stop()
			const foreign = https.createServer((_req, res) => {
				res.end("{}") // answers without our health payload → probe says "not ours"
			})
			await new Promise<void>((resolve, reject) => {
				foreign.once("error", reject)
				foreign.listen(port, () => resolve())
			})
			const third = new RemoteServer({ port, token, certDir: path.join(certDir, "third") })
			let foreignError: unknown
			try {
				await third.start()
			} catch (error) {
				foreignError = error
			}
			expect(foreignError).toBeInstanceOf(RemotePortInUseError)
			expect((foreignError as RemotePortInUseError).ownInstance).toBe(false)

			await new Promise<void>((resolve, reject) => {
				foreign.closeAllConnections?.()
				foreign.close((error) => (error ? reject(error) : resolve()))
			})
		} finally {
			if (first.isRunning) {
				await first.stop().catch(() => undefined)
			}
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
