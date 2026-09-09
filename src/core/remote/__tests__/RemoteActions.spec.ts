import { providerIdentifiers, TaskStatus } from "@roo-code/types"
import type { ClineMessage, ProviderSettingsEntry } from "@roo-code/types"

import type { ClineProvider } from "../../webview/ClineProvider"
import { RemoteActions } from "../RemoteActions"

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
	handleWebviewAskResponse(askResponse: string, text?: string): void
	approveAsk(): void
	denyAsk(): void
}

function makeTask(overrides: { taskStatus?: TaskStatus; taskAsk?: ClineMessage | null } = {}): MockTask {
	const calls: Array<["approve"] | ["deny"] | ["handle", string, string?]> = []
	return {
		calls,
		taskId: "task-1",
		taskStatus: overrides.taskStatus ?? TaskStatus.Interactive,
		// `null` in the override means "explicitly no ask" (avoids the default tool ask below).
		taskAsk:
			overrides.taskAsk === null
				? undefined
				: overrides.taskAsk ?? ({ ts: 1, type: "ask", ask: "tool" } as ClineMessage),
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
		providerSettingsManager: {
			listConfig: async (): Promise<ProviderSettingsEntry[]> => [
				{ id: "profile-a", name: "default", apiProvider: providerIdentifiers.anthropic, modelId: "claude-sonnet-4-5" },
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
			await expect(actions.respondToAsk("messageResponse")).resolves.toEqual({ ok: false, error: "text_required" })
			await expect(actions.respondToAsk("messageResponse", "   ")).resolves.toEqual({ ok: false, error: "text_required" })
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
			await expect(actions.respondToAsk("yesButtonClicked")).resolves.toEqual({ ok: false, error: "no_active_task" })
		})

		it("fails with no_pending_ask when the task is running", async () => {
			const provider = makeProvider()
			provider.task = makeTask({ taskStatus: TaskStatus.Running, taskAsk: null })
			const actions = new RemoteActions(toClineProvider(provider))
			await expect(actions.respondToAsk("yesButtonClicked")).resolves.toEqual({ ok: false, error: "no_pending_ask" })
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
					{ id: "profile-a", name: "default", provider: providerIdentifiers.anthropic, modelId: "claude-sonnet-4-5" },
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
})
