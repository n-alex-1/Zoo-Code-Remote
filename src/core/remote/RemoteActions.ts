import { getModelId, modelIdKeysByProvider } from "@roo-code/types"
import type { ProviderSettings, ProviderSettingsWithId } from "@roo-code/types"

import { getModeBySlug } from "../../shared/modes"
import type { ClineProvider } from "../webview/ClineProvider"

import type { ModeInfo, ProfileInfo, RemoteActionResult, RemoteAskResponse, RemoteModelsResponse } from "./types"

/** Valid values for `POST /api/ask/respond` (contract: docs/architektur.md §3). */
const VALID_ASK_RESPONSES: readonly RemoteAskResponse[] = ["yesButtonClicked", "noButtonClicked", "messageResponse"] as const

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
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
			if (ask?.type !== "ask") {
				return { ok: false, error: "no_pending_ask" }
			}

			if (response === "messageResponse") {
				const trimmed = typeof text === "string" ? text.trim() : ""
				if (!trimmed) {
					return { ok: false, error: "text_required" }
				}
				task.handleWebviewAskResponse("messageResponse", trimmed)
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

				await this.provider.providerSettingsManager.saveConfig(entry.name, { ...full, [modelKey]: trimmedModel })
			}

			// Same path as the webview's profile switch (also rebuilds the task API handler + emits ProviderProfileChanged).
			await this.provider.activateProviderProfile({ name: entry.name })
			return { ok: true }
		} catch (error) {
			this.log?.("setModel failed: " + errorMessage(error))
			return { ok: false, error: errorMessage(error) }
		}
	}
}
