import fs from "fs/promises"
import os from "os"
import path from "path"

import { providerIdentifiers, TaskStatus } from "@roo-code/types"
import type { ClineMessage, ProviderSettingsEntry } from "@roo-code/types"

import type { ClineProvider } from "../../webview/ClineProvider"
import { RemoteActions } from "../RemoteActions"

// The `code` CLI is spawned detached for openWorkspace; mock it so tests are deterministic.
const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(() => ({
		once: (event: string, callback: () => void) => {
			if (event === "spawn") {
				setImmediate(callback)
			}
		},
		unref: vi.fn(),
	})),
}))

vi.mock("child_process", () => ({ spawn: spawnMock }))

/** Structural mock of the provider surface RemoteActions touches (avoids importing the full class shape). */
type MockProvider = {
	task: MockTask
	getCurrentTask(): MockTask | undefined
	handleModeSwitch(mode: string): Promise<void>
	customModesManager: { getCustomModes(): Promise<Array<{ slug: string; name: string }>> }
	getModes(): Promise<Array<{ slug: string; name: string }>>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock state is loosely typed on purpose
	getStateToPostToWebview(options?: { includeTaskHistory?: boolean }): Promise<any>
	providerSettingsManager: {
		listConfig(): Promise<ProviderSettingsEntry[]>
		getProfile(params: { id: string } | { name: string }): Promise<Record<string, unknown>>
		saveConfig(name: string, config: Record<string, unknown>): Promise<string>
	}
	activateProviderProfile(args: { name?: string; id?: string }): Promise<void>
	// Session 9 surfaces.
	taskHistoryStore: MockTaskHistoryStore
	createTask(text?: string): Promise<unknown>
	showTaskWithId(id: string): Promise<void>
	cancelTask(): Promise<void>
}

/** Minimal mock of the task history store surface RemoteActions touches (session 9). */
interface MockTaskHistoryStore {
	initialized: Promise<void>
	getAll(): Array<{ id: string; ts: number; task: string; mode?: string; status?: string; workspace?: string }>
}

function makeTaskHistoryStore(overrides: Partial<MockTaskHistoryStore> = {}): MockTaskHistoryStore {
	return {
		initialized: Promise.resolve(),
		getAll: () => [
			{ id: "task-new", ts: 2000, task: "Newer session title", mode: "code", status: "active" },
			{ id: "task-old", ts: 1000, task: "Older session title", workspace: "/tmp/proj" },
			// Session 9: entries from another workspace (the per-workspace filter must keep/drop them).
			{ id: "task-other-ws", ts: 3000, task: "Session in other project", workspace: "/other/project" },
			// Entries without ts/task must be filtered out by RemoteActions.listTasks.
			{ id: "task-broken", ts: 0, task: "" } as never,
		],
		...overrides,
	}
}

function toClineProvider(provider: MockProvider): ClineProvider {
	return provider as unknown as ClineProvider
}

/** Minimal mock of the Task surface RemoteActions touches. */
interface MockTask {
	calls: Array<["approve"] | ["deny"] | ["handle", string, string?]>
	taskId: string
	taskStatus: TaskStatus
	taskAsk: ClineMessage | undefined
	queuedMessages: unknown[]
	messageQueueService?: { addMessage(text: string): void }
	queuedTexts: string[]
	handleWebviewAskResponse(askResponse: string, text?: string): void
	approveAsk(): void
	denyAsk(): void
}

function makeTask(
	overrides: { taskStatus?: TaskStatus; taskAsk?: ClineMessage | null; queuedCount?: number } = {},
): MockTask {
	const calls: Array<["approve"] | ["deny"] | ["handle", string, string?]> = []
	const queuedTexts: string[] = []
	return {
		calls,
		taskId: "task-1",
		taskStatus: overrides.taskStatus ?? TaskStatus.Interactive,
		// `null` in the override means "explicitly no ask" (avoids the default tool ask below).
		taskAsk:
			overrides.taskAsk === null
				? undefined
				: (overrides.taskAsk ?? ({ ts: 1, type: "ask", ask: "tool" } as ClineMessage)),
		queuedMessages: Array.from({ length: overrides.queuedCount ?? 0 }, (_, index) => ({ id: `q-${index}` })),
		messageQueueService: { addMessage: (text: string) => queuedTexts.push(text) },
		queuedTexts,
		handleWebviewAskResponse(askResponse: string, text?: string) {
			calls.push(["handle", askResponse, text])
		},
		approveAsk() {
			calls.push(["approve"])
		},
		denyAsk() {
			calls.push(["deny"])
		},
	}
}

function makeProvider(overrides: Record<string, unknown> = {}): MockProvider {
	let task = makeTask()
	return {
		get task(): MockTask {
			return task
		},
		set task(value: MockTask) {
			task = value
		},
		getCurrentTask: () => task,
		handleModeSwitch: vi.fn(async (_mode: string) => undefined),
		customModesManager: { getCustomModes: async () => [{ slug: "my-mode", name: "My Mode" }] },
		getModes: async () => [
			{ slug: "code", name: "💻 Code" },
			{ slug: "architect", name: "🏗️ Architect" },
			{ slug: "my-mode", name: "My Mode" },
		],
		getStateToPostToWebview: async () => ({
			version: "9.9.9-test",
			mode: "code",
			currentApiConfigName: "default",
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" },
		}),
		// Session 9 surfaces (task history / start / open / cancel).
		taskHistoryStore: makeTaskHistoryStore(),
		createTask: vi.fn(async (_text?: string) => undefined),
		showTaskWithId: vi.fn(async (_id: string) => undefined),
		cancelTask: vi.fn(async () => undefined),
		providerSettingsManager: {
			listConfig: async (): Promise<ProviderSettingsEntry[]> => [
				{
					id: "profile-a",
					name: "default",
					apiProvider: providerIdentifiers.anthropic,
					modelId: "claude-sonnet-4-5",
				},
				{
					id: "profile-b",
					name: "bedrock profile",
					apiProvider: providerIdentifiers.bedrock,
					modelId: "us.anthropic.claude-3-5-sonnet",
				},
			],
			getProfile: async ({ id }: { id: string }) => ({
				id,
				name: id === "profile-a" ? "default" : "bedrock profile",
				apiProvider: id === "profile-a" ? providerIdentifiers.anthropic : providerIdentifiers.bedrock,
			}),
			saveConfig: vi.fn(async (_name: string, _config: unknown) => "saved-id"),
		},
		activateProviderProfile: vi.fn(async () => undefined),
		...overrides,
	}
}

describe("RemoteActions", () => {
	describe("respondToAsk", () => {
		it("approves via approveAsk (webview askResponse path)", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("yesButtonClicked")).resolves.toEqual({ ok: true })
			expect(provider.task.calls).toEqual([["approve"]])
		})

		it("denies via denyAsk", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("noButtonClicked")).resolves.toEqual({ ok: true })
			expect(provider.task.calls).toEqual([["deny"]])
		})

		it("sends free text via handleWebviewAskResponse('messageResponse', text)", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("messageResponse", "  fix the bug  ")).resolves.toEqual({ ok: true })
			expect(provider.task.calls).toEqual([["handle", "messageResponse", "fix the bug"]])
		})

		it("rejects messageResponse without text", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.respondToAsk("messageResponse")).resolves.toEqual({
				ok: false,
				error: "text_required",
			})
			await expect(actions.respondToAsk("messageResponse", "   ")).resolves.toEqual({
				ok: false,
				error: "text_required",
			})
		})

		it("rejects unknown response values", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.respondToAsk("maybeButtonClicked" as never)).resolves.toEqual({
				ok: false,
				error: "invalid_response",
			})
		})

		it("fails with no_active_task when there is no current task", async () => {
			const provider = makeProvider()
			provider.getCurrentTask = () => undefined
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.respondToAsk("yesButtonClicked")).resolves.toEqual({
				ok: false,
				error: "no_active_task",
			})
		})

		it("fails with no_pending_ask when the task is running", async () => {
			const provider = makeProvider()
			provider.task = makeTask({ taskStatus: TaskStatus.Running, taskAsk: null })
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.respondToAsk("yesButtonClicked")).resolves.toEqual({
				ok: false,
				error: "no_pending_ask",
			})
		})

		it("session 9: queues messageResponse into the task queue while running (no pending ask)", async () => {
			const provider = makeProvider()
			provider.task = makeTask({ taskStatus: TaskStatus.Running, taskAsk: null })
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("messageResponse", "keep going")).resolves.toEqual({ ok: true })
			expect(provider.task.queuedTexts).toEqual(["keep going"])
			expect(provider.task.calls).toEqual([])
		})

		it("session 9: keeps queueing while the message queue is still draining (even when not running)", async () => {
			const provider = makeProvider()
			provider.task = makeTask({ taskStatus: TaskStatus.Idle, taskAsk: null, queuedCount: 1 })
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("messageResponse", "second note")).resolves.toEqual({ ok: true })
			expect(provider.task.queuedTexts).toEqual(["second note"])
			expect(provider.task.calls).toEqual([])
		})

		it("session 9: falls back to handleWebviewAskResponse when running without a queue service", async () => {
			const provider = makeProvider()
			const task = makeTask({ taskStatus: TaskStatus.Running, taskAsk: null })
			task.messageQueueService = undefined
			provider.task = task
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("messageResponse", "keep going")).resolves.toEqual({ ok: true })
			expect(task.queuedTexts).toEqual([])
			expect(task.calls).toEqual([["handle", "messageResponse", "keep going"]])
		})

		it("session 9: a pending ask is answered directly, never queued (even while running)", async () => {
			const provider = makeProvider()
			provider.task = makeTask({ taskStatus: TaskStatus.Running })
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("messageResponse", "answer")).resolves.toEqual({ ok: true })
			expect(provider.task.queuedTexts).toEqual([])
			expect(provider.task.calls).toEqual([["handle", "messageResponse", "answer"]])
		})

		it("session 9: messageResponse without text still fails with text_required (even without a pending ask)", async () => {
			const provider = makeProvider()
			provider.task = makeTask({ taskStatus: TaskStatus.Running, taskAsk: null })
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.respondToAsk("messageResponse", "  ")).resolves.toEqual({
				ok: false,
				error: "text_required",
			})
		})

		it("does not throw when the underlying call fails", async () => {
			const provider = makeProvider()
			const failingTask = makeTask()
			failingTask.approveAsk = () => {
				throw new Error("boom")
			}
			provider.task = failingTask
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.respondToAsk("yesButtonClicked")).resolves.toEqual({ ok: false, error: "boom" })
		})
	})

	describe("setMode", () => {
		it("switches via handleModeSwitch for built-in modes", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.setMode("architect")).resolves.toEqual({ ok: true })
			expect(provider.handleModeSwitch).toHaveBeenCalledTimes(1)
			expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect")
		})

		it("switches via handleModeSwitch for custom modes", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.setMode("my-mode")).resolves.toEqual({ ok: true })
			expect(provider.handleModeSwitch).toHaveBeenCalledWith("my-mode")
		})

		it("fails for unknown slugs", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.setMode("nope")).resolves.toEqual({ ok: false, error: "unknown_mode" })
		})

		it("fails for empty slugs", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.setMode("   ")).resolves.toEqual({ ok: false, error: "invalid_slug" })
		})

		it("does not throw when handleModeSwitch fails", async () => {
			const provider = makeProvider()
			provider.handleModeSwitch = vi.fn(async () => {
				throw new Error("switch failed")
			}) as MockProvider["handleModeSwitch"]
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.setMode("architect")).resolves.toEqual({ ok: false, error: "switch failed" })
		})
	})

	describe("listModes", () => {
		it("returns all modes incl. custom modes", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			const result = await actions.listModes()
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.modes).toEqual([
					{ slug: "code", name: "💻 Code" },
					{ slug: "architect", name: "🏗️ Architect" },
					{ slug: "my-mode", name: "My Mode" },
				])
			}
		})

		it("reports errors instead of throwing", async () => {
			const provider = makeProvider()
			provider.getModes = async () => {
				throw new Error("modes failed")
			}
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.listModes()).resolves.toEqual({ ok: false, error: "modes failed" })
		})
	})

	describe("listModels", () => {
		it("returns profiles and the current model id", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			const result = await actions.listModels()
			expect(result).toEqual({
				ok: true,
				profiles: [
					{
						id: "profile-a",
						name: "default",
						provider: providerIdentifiers.anthropic,
						modelId: "claude-sonnet-4-5",
					},
					{
						id: "profile-b",
						name: "bedrock profile",
						provider: providerIdentifiers.bedrock,
						modelId: "us.anthropic.claude-3-5-sonnet",
					},
				],
				currentModel: "claude-sonnet-4-5",
			})
		})

		it("reports errors instead of throwing", async () => {
			const provider = makeProvider()
			provider.providerSettingsManager.listConfig = async () => {
				throw new Error("list failed")
			}
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.listModels()).resolves.toEqual({ ok: false, error: "list failed" })
		})
	})

	describe("setModel", () => {
		it("activates the profile by id via activateProviderProfile", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.setModel("profile-b")).resolves.toEqual({ ok: true })
			expect(provider.activateProviderProfile).toHaveBeenCalledWith({ name: "bedrock profile" })
			// No model override → no saveConfig call.
			expect(provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
		})

		it("activates the profile by name as well", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.setModel("default")).resolves.toEqual({ ok: true })
			expect(provider.activateProviderProfile).toHaveBeenCalledWith({ name: "default" })
		})

		it("saves the model override into the provider-specific field before activating", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.setModel("profile-a", "claude-opus-4")).resolves.toEqual({ ok: true })
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", {
				id: "profile-a",
				name: "default",
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4",
			})
			expect(provider.activateProviderProfile).toHaveBeenCalledWith({ name: "default" })
		})

		it("skips the save when the model is unchanged", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.setModel("profile-a", "claude-sonnet-4-5")).resolves.toEqual({ ok: true })
			expect(provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
		})

		it("fails for unknown profile ids", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.setModel("nope")).resolves.toEqual({ ok: false, error: "unknown_profile" })
		})

		it("fails for empty profile ids", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.setModel("  ")).resolves.toEqual({ ok: false, error: "invalid_profile_id" })
		})

		it("does not throw when activation fails", async () => {
			const provider = makeProvider()
			provider.activateProviderProfile = vi.fn(async () => {
				throw new Error("activate failed")
			})
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.setModel("profile-a")).resolves.toEqual({ ok: false, error: "activate failed" })
		})
	})

	describe("listTasks (session 9)", () => {
		it("returns the global history newest first and filters incomplete entries", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			const result = await actions.listTasks()
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.tasks.map((task) => task.taskId)).toEqual(["task-other-ws", "task-new", "task-old"])
			}
		})

		it("filters by workspace when given (same comparison as the webview's history list)", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))

			const match = await actions.listTasks("/tmp/proj")
			expect(match.ok).toBe(true)
			if (match.ok) {
				expect(match.tasks.map((task) => task.taskId)).toEqual(["task-old"])
			}

			const other = await actions.listTasks("/other/project")
			expect(other.ok).toBe(true)
			if (other.ok) {
				expect(other.tasks.map((task) => task.taskId)).toEqual(["task-other-ws"])
			}

			// Unknown workspace → empty list, no error.
			const none = await actions.listTasks("/nowhere")
			expect(none).toEqual({ ok: true, tasks: [] })
		})

		it("treats a blank workspace as global (no filtering)", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			const result = await actions.listTasks("  ")
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.tasks.map((task) => task.taskId)).toEqual(["task-other-ws", "task-new", "task-old"])
			}
		})

		it("reports errors instead of throwing", async () => {
			const provider = makeProvider()
			provider.taskHistoryStore = makeTaskHistoryStore({ initialized: Promise.reject(new Error("store failed")) })
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.listTasks()).resolves.toEqual({ ok: false, error: "store failed" })
		})
	})

	describe("startTask (session 9)", () => {
		it("starts a task via createTask with the trimmed text", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.startTask("  fix the bug  ")).resolves.toEqual({ ok: true })
			expect(provider.createTask).toHaveBeenCalledWith("fix the bug", undefined, undefined, {})
		})

		it("fails for empty text without calling createTask", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.startTask("   ")).resolves.toEqual({ ok: false, error: "invalid_text" })
			expect(provider.createTask).not.toHaveBeenCalled()
		})

		it("does not throw when createTask fails", async () => {
			const provider = makeProvider()
			provider.createTask = vi.fn(async () => {
				throw new Error("start failed")
			}) as MockProvider["createTask"]
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.startTask("go")).resolves.toEqual({ ok: false, error: "start failed" })
		})
	})

	describe("openTask (session 9)", () => {
		it("restores a session via showTaskWithId", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.openTask("task-old")).resolves.toEqual({ ok: true })
			expect(provider.showTaskWithId).toHaveBeenCalledWith("task-old")
		})

		it("fails for empty ids", async () => {
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.openTask("  ")).resolves.toEqual({ ok: false, error: "invalid_task_id" })
		})

		it("maps 'not found' errors to unknown_task", async () => {
			const provider = makeProvider()
			provider.showTaskWithId = vi.fn(async () => {
				throw new Error("Task not found")
			}) as MockProvider["showTaskWithId"]
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.openTask("nope")).resolves.toEqual({ ok: false, error: "unknown_task" })
		})
	})

	describe("cancelTask (session 9)", () => {
		it("cancels the current task", async () => {
			const provider = makeProvider()
			const actions = new RemoteActions(toClineProvider(provider))

			await expect(actions.cancelTask()).resolves.toEqual({ ok: true })
			expect(provider.cancelTask).toHaveBeenCalledTimes(1)
		})

		it("fails with no_active_task when there is no current task", async () => {
			const provider = makeProvider()
			provider.getCurrentTask = () => undefined
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.cancelTask()).resolves.toEqual({ ok: false, error: "no_active_task" })
			expect(provider.cancelTask).not.toHaveBeenCalled()
		})
	})

	describe("workspaces (session 9)", () => {
		it("lists recent workspaces from the user-data dir, newest first", async () => {
			const base = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-remote-ws-"))
			try {
				// RemoteActions resolves <APPDATA>/Code/User on win32 and <homedir>/.config/Code/User elsewhere.
				let userData: string
				if (process.platform === "win32") {
					userData = path.join(base, "Code", "User")
					vi.spyOn(process, "env", "get").mockReturnValue({ APPDATA: base } as NodeJS.ProcessEnv)
				} else {
					vi.spyOn(os, "homedir").mockReturnValue(base)
					userData = path.join(base, ".config", "Code", "User")
				}

				await fs.mkdir(path.join(userData, "workspaceStorage", "aaa"), { recursive: true })
				await fs.writeFile(
					path.join(userData, "workspaceStorage", "aaa", "workspace.json"),
					JSON.stringify({ folder: "file:///tmp/project-a", name: "Project A" }),
				)
				await fs.mkdir(path.join(userData, "workspaceStorage", "bbb"), { recursive: true })
				await fs.writeFile(
					path.join(userData, "workspaceStorage", "bbb", "workspace.json"),
					JSON.stringify({ folder: "file:///tmp/project-b" }),
				)
				// Make the second entry newer.
				const future = new Date(Date.now() + 60_000).getTime()
				await fs.utimes(
					path.join(userData, "workspaceStorage", "bbb", "workspace.json"),
					future / 1000,
					future / 1000,
				)

				const actions = new RemoteActions(toClineProvider(makeProvider()))
				const result = await actions.listWorkspaces()
				expect(result.ok).toBe(true)
				if (result.ok) {
					expect(result.workspaces.map((w) => w.path)).toEqual(["/tmp/project-b", "/tmp/project-a"])
					expect(result.workspaces[1].name).toBe("Project A")
				}
			} finally {
				vi.restoreAllMocks()
				await fs.rm(base, { recursive: true, force: true })
			}
		})

		it("returns an empty list when the user-data dir is absent", async () => {
			const missing = path.join(os.tmpdir(), "zoo-remote-does-not-exist-" + Date.now())
			if (process.platform === "win32") {
				vi.spyOn(process, "env", "get").mockReturnValue({ APPDATA: missing } as NodeJS.ProcessEnv)
			} else {
				vi.spyOn(os, "homedir").mockReturnValue(missing)
			}
			const actions = new RemoteActions(toClineProvider(makeProvider()))
			await expect(actions.listWorkspaces()).resolves.toEqual({ ok: true, workspaces: [] })
			vi.restoreAllMocks()
		})

		it("opens a workspace via the code CLI (detached spawn)", async () => {
			spawnMock.mockClear()
			const actions = new RemoteActions(toClineProvider(makeProvider()))

			await expect(actions.openWorkspace("/tmp/project-a")).resolves.toEqual({ ok: true })
			expect(spawnMock).toHaveBeenCalledTimes(1)
		})

		it("fails for empty paths without spawning", async () => {
			spawnMock.mockClear()
			const actions = new RemoteActions(toClineProvider(makeProvider()))

			await expect(actions.openWorkspace("  ")).resolves.toEqual({ ok: false, error: "invalid_path" })
			expect(spawnMock).not.toHaveBeenCalled()
		})
	})
})
