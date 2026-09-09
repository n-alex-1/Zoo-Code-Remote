import * as vscode from "vscode"
import path from "path"

import type { ClineProvider } from "../webview/ClineProvider"

import { generateRemoteToken } from "./RemoteAuth"
import { RemoteActions } from "./RemoteActions"
import { RemoteServer } from "./RemoteServer"
import { RemoteStateBridge } from "./RemoteStateBridge"

import {
	REMOTE_DEFAULT_PORT,
	REMOTE_ENABLED_SETTING,
	REMOTE_MAX_PORT,
	REMOTE_MIN_PORT,
	REMOTE_PORT_SETTING,
	REMOTE_TOKEN_SECRET_KEY,
	type RemoteActionSource,
	type RemoteInfoPayload,
	type RemoteStatusProvider,
} from "./types"
/**
 * Owns the remote server lifecycle and its settings.
 *
 * Reads `zoo-code.remote.enabled` / `zoo-code.remote.port` (VS Code configuration),
 * keeps the bearer token in SecretStorage (`zooRemote.token`) and starts/stops the
 * RemoteServer live when the settings change. Exposed to the webview via
 * {@link getRemoteInfo} for the "Remote Control" settings section.
 */
export class RemoteControl implements vscode.Disposable {
	private readonly context: vscode.ExtensionContext
	private readonly outputChannel: vscode.OutputChannel
	private readonly provider?: ClineProvider
	private server?: RemoteServer
	private bridge?: RemoteStateBridge
	private actions?: RemoteActions
	private tokenPromise?: Promise<string>
	private configListener?: vscode.Disposable

	constructor(context: vscode.ExtensionContext, provider?: ClineProvider) {
		this.context = context
		this.provider = provider
		this.outputChannel = vscode.window.createOutputChannel("Zoo Remote")
	}

	async initialize(): Promise<void> {
		await this.startIfEnabled()

		this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(this.enabledSettingKey()) || event.affectsConfiguration(this.portSettingKey())) {
				void this.restartIfNecessary().catch((error) => {
					this.log("Restart after settings change failed: " + (error instanceof Error ? error.message : String(error)))
				})
			}
		})
	}

	async dispose(): Promise<void> {
		this.configListener?.dispose()
		await this.stopServer()
		this.outputChannel.dispose()
	}

	getRemoteInfo(): RemoteInfoPayload {
		return {
			enabled: this.isEnabled(),
			port: this.getPort(),
			running: this.server?.isRunning ?? false,
			token: null, // filled in by the async caller (SecretStorage read)
			fingerprint: this.server?.fingerprint ?? null,
		}
	}

	async getRemoteInfoAsync(): Promise<RemoteInfoPayload> {
		const info = this.getRemoteInfo()
		try {
			info.token = await this.getToken()
		} catch (error) {
			this.log("Failed to read token: " + (error instanceof Error ? error.message : String(error)))
		}
		return info
	}

	private enabledSettingKey(): string {
		return `${PackageName}.${REMOTE_ENABLED_SETTING}`
	}

	private portSettingKey(): string {
		return `${PackageName}.${REMOTE_PORT_SETTING}`
	}

	private isEnabled(): boolean {
		const config = vscode.workspace.getConfiguration(PackageName)
		return config.get<boolean>(REMOTE_ENABLED_SETTING, false) === true
	}

	private getPort(): number {
		const config = vscode.workspace.getConfiguration(PackageName)
		const raw = config.get<number>(REMOTE_PORT_SETTING, REMOTE_DEFAULT_PORT)
		if (typeof raw !== "number" || !Number.isInteger(raw)) {
			return REMOTE_DEFAULT_PORT
		}
		return Math.min(Math.max(raw, REMOTE_MIN_PORT), REMOTE_MAX_PORT)
	}

	private getToken(): Promise<string> {
		this.tokenPromise ??= this.loadOrCreateToken()
		return this.tokenPromise
	}

	private async loadOrCreateToken(): Promise<string> {
		const existing = await this.context.secrets.get(REMOTE_TOKEN_SECRET_KEY)
		if (existing && typeof existing === "string" && existing.length > 0) {
			return existing
		}
		const token = generateRemoteToken()
		await this.context.secrets.store(REMOTE_TOKEN_SECRET_KEY, token)
		this.log("Generated a new remote access token (see Settings → Remote Control).")
		return token
	}

	private async startIfEnabled(): Promise<void> {
		if (!this.isEnabled()) {
			return
		}
		const port = this.getPort()
		await this.startServer(port)
		this.log(`Remote server enabled on https://<host>:${port}`)
		this.log("Open Settings → Remote Control in Zoo Code to copy the token and certificate fingerprint.")
	}

	private async startServer(port: number): Promise<void> {
		if (this.server?.isRunning) {
			await this.stopServer()
		}

		const token = await this.getToken()
		const certDir = path.join(this.context.globalStorageUri.fsPath, "remote")

		// Status/activity bridge + action layer — only when the provider is available.
		if (this.provider) {
			this.bridge?.stop()
			this.bridge = new RemoteStateBridge(this.provider, (line) => this.log(line))
			this.bridge.start()
			this.actions = new RemoteActions(this.provider, (line) => this.log(line))
		} else {
			this.actions = undefined
			this.log("No ClineProvider supplied — remote status/action APIs fall back to 503 until Session wiring is complete.")
		}

		const statusProvider: RemoteStatusProvider | undefined = this.bridge ?? undefined
		const actionProvider: RemoteActionSource | undefined = this.actions ?? undefined

		try {
			this.server = new RemoteServer({
				port,
				token,
				certDir,
				statusProvider,
				actionProvider,
				log: (line) => this.log(line),
			})
			await this.server.start()
		} catch (error) {
			// Server did not come up — release the bridge again.
			this.bridge?.stop()
			this.bridge = undefined
			this.actions = undefined
			throw error
		}
	}

	private async stopServer(): Promise<void> {
		if (!this.server) {
			return
		}
		const server = this.server
		this.server = undefined
		try {
			await server.stop()
		} catch (error) {
			this.log("Error while stopping remote server: " + (error instanceof Error ? error.message : String(error)))
		} finally {
			this.bridge?.stop()
			this.bridge = undefined
			this.actions = undefined
		}
	}

	private async restartIfNecessary(): Promise<void> {
		const enabled = this.isEnabled()
		const port = this.getPort()
		const running = this.server?.isRunning ?? false

		if (enabled && !running) {
			await this.startServer(port)
		} else if (!enabled && running) {
			await this.stopServer()
		} else if (enabled && running && this.server!.port !== port) {
			// Port changed while active → restart on the new port.
			await this.startServer(port)
		}
	}

	private log(line: string): void {
		this.outputChannel.appendLine(line)
	}
}

const PackageName = "zoo-code"

/**
 * Module-level instance holder so the webview message handler can reach the active
 * RemoteControl without importing extension.ts (which would create an import cycle).
 */
let currentInstance: RemoteControl | undefined

export function setRemoteControlInstance(instance: RemoteControl | undefined): void {
	currentInstance = instance
}

export function getRemoteControl(): RemoteControl | undefined {
	return currentInstance
}
