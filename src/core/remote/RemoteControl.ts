import * as vscode from "vscode"
import fsPromises from "fs/promises"
import path from "path"

import type { ClineProvider } from "../webview/ClineProvider"

import { generateRemoteToken } from "./RemoteAuth"
import { RemoteActions } from "./RemoteActions"
import { RemotePortInUseError, RemoteServer } from "./RemoteServer"
import { RemoteStateBridge } from "./RemoteStateBridge"

import {
	REMOTE_ALLOWED_IPS_SETTING,
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
	/** Tracks the (non-blocking) initial start so dispose() can wait for it to settle. */
	private startPromise?: Promise<void>
	private configListener?: vscode.Disposable
	private statusBarItem?: vscode.StatusBarItem

	constructor(context: vscode.ExtensionContext, provider?: ClineProvider) {
		this.context = context
		this.provider = provider
		this.outputChannel = vscode.window.createOutputChannel("Zoo Remote")
	}

	async initialize(): Promise<void> {
		// Start without blocking extension activation (Session 8a): certificate generation and the
		// port bind happen in the background; failures are reported via OutputChannel + status bar.
		this.startPromise = this.startIfEnabled().catch((error) => {
			this.log("Remote server start failed: " + (error instanceof Error ? error.message : String(error)))
			this.showPortWarning(this.getPort(), "Start fehlgeschlagen — Details im Output-Channel „Zoo Remote“")
		})

		this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration(this.enabledSettingKey()) ||
				event.affectsConfiguration(this.portSettingKey()) ||
				event.affectsConfiguration(this.allowedIpsSettingKey())
			) {
				void this.restartIfNecessary().catch((error) => {
					this.log(
						"Restart after settings change failed: " +
							(error instanceof Error ? error.message : String(error)),
					)
				})
			}
		})
	}

	async dispose(): Promise<void> {
		this.configListener?.dispose()
		await this.startPromise?.catch(() => undefined) // let the background start settle before tearing down
		await this.stopServer()
		this.clearPortWarning()
		this.outputChannel.dispose()
	}

	getRemoteInfo(): RemoteInfoPayload {
		return {
			enabled: this.isEnabled(),
			port: this.getPort(),
			running: this.server?.isRunning ?? false,
			token: null, // filled in by the async caller (SecretStorage read)
			fingerprint: this.server?.fingerprint ?? null,
			pairing: this.server?.pairingState,
		}
	}

	/**
	 * "Pairing starten" (Settings tab): opens a 120 s one-shot window so the app can fetch token +
	 * fingerprint via `POST /api/pair`. No credential rotation — an already-paired device keeps
	 * working, and a second device is rejected with `already_paired` until "Zurücksetzen".
	 */
	async startPairing(): Promise<void> {
		const server = this.server
		if (!server?.isRunning) {
			this.log("Pairing started while the remote server is not running — it will be available as soon as it starts.")
			return
		}
		server.openPairingWindow(false)
		this.log('Pairing window open for 120 s - press "Pairing" in the Zoo Remote app (host/IP + port only).')
		await this.pushRemoteInfo()
	}

	/**
	 * "Pairing zurücksetzen": rotates token AND certificate (new fingerprint), then opens a fresh
	 * one-shot window. Previously paired devices fail with 401 / fingerprint mismatch and fall
	 * back to the setup screen automatically — exactly the re-pair flow they already had.
	 */
	async resetPairing(): Promise<void> {
		const server = this.server
		if (!server?.isRunning) {
			this.log("Pairing reset while the remote server is not running.")
			return
		}

		// 1) New token (SecretStorage). In-flight REST/WS requests with the old token get 401 →
		//    the app's existing authError flow navigates it back to setup.
		const newToken = generateRemoteToken()
		await this.context.secrets.store(REMOTE_TOKEN_SECRET_KEY, newToken)

		// 2) New certificate: delete the stored PEMs so loadOrCreateCertificate regenerates them.
		const certDir = path.join(this.context.globalStorageUri.fsPath, "remote")
		try {
			await Promise.all([
				fsPromises.unlink(path.join(certDir, "remote-cert.pem")),
				fsPromises.unlink(path.join(certDir, "remote-key.pem")),
			])
		} catch (error) {
			this.log("Could not delete stored certificate (will be overwritten on regeneration): " + errorText(error))
		}

		// 3) Restart the server with fresh credentials, then open a rotated pairing window. The
		//    state machine belongs to the NEW server instance — `server` is stale after the restart.
		await this.startServer(this.getPort())
		this.server?.openPairingWindow(true)
		this.log("Token + Zertifikat neu generiert (Pairing zurückgesetzt). Neues Fenster offen — App jetzt pairen.")
		await this.pushRemoteInfo()
	}

	/** Pushes the current remoteInfo payload to the webview (best effort — it may not be open). */
	private async pushRemoteInfo(): Promise<void> {
		try {
			const provider = this.provider as unknown as { postMessageToWebview?: (message: Record<string, unknown>) => Promise<void> } | undefined
			await provider?.postMessageToWebview?.({ type: "remoteInfo", remoteInfoPayload: await this.getRemoteInfoAsync() })
		} catch (error) {
			this.log("Failed to push remoteInfo after pairing change: " + errorText(error))
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

	private allowedIpsSettingKey(): string {
		return `${PackageName}.${REMOTE_ALLOWED_IPS_SETTING}`
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

	private getAllowedIps(): string[] {
		const config = vscode.workspace.getConfiguration(PackageName)
		const raw = config.get<unknown>(REMOTE_ALLOWED_IPS_SETTING, [])
		if (!Array.isArray(raw)) {
			return []
		}
		return raw.filter((entry): entry is string => typeof entry === "string")
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
		try {
			await this.startServer(port)
		} catch (error) {
			// Swallowed on purpose: handleStartFailure reports to OutputChannel/status bar and
			// decides between degraded mode (other window) and a visible warning. Activation must not fail.
			this.handleStartFailure(error, port)
			return
		}
		this.clearPortWarning()
		this.log(`Remote server enabled on https://<host>:${port}`)
		this.log("Open Settings → Remote Control in Zoo Code to copy the token and certificate fingerprint.")
	}

	/**
	 * Session 8a: EADDRINUSE is expected when a second VS Code window runs the same extension.
	 * A health probe distinguishes "another Zoo Code window" (degraded mode — log only, no warning)
	 * from any foreign process on the port (status-bar warning + OutputChannel message).
	 */
	private handleStartFailure(error: unknown, port: number): void {
		if (error instanceof RemotePortInUseError && error.ownInstance) {
			this.log(
				`Remote server in degraded mode — port ${port} is already served by another Zoo Code window; this window only logs.`,
			)
			return
		}
		const message =
			error instanceof RemotePortInUseError
				? `Remote-Port ${port} ist bereits belegt (anderer Prozess).`
				: "Remote-Server konnte nicht gestartet werden — Details im Output-Channel „Zoo Remote“."
		this.log(message)
		this.showPortWarning(port, message)
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
			this.log(
				"No ClineProvider supplied — remote status/action APIs fall back to 503 until Session wiring is complete.",
			)
		}

		const statusProvider: RemoteStatusProvider | undefined = this.bridge ?? undefined
		const actionProvider: RemoteActionSource | undefined = this.actions ?? undefined

		const allowedIps = this.getAllowedIps()
		try {
			this.server = new RemoteServer({
				port,
				token,
				certDir,
				statusProvider,
				actionProvider,
				log: (line) => this.log(line),
				allowedIps,
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

		if (!enabled && running) {
			await this.stopServer()
			return
		}

		// Not enabled and not running → nothing to do. Otherwise start or restart: the listener
		// only fires for remote.* settings, so a change while running means port or allowedIps
		// moved — both are passed at construction time, hence a full restart picks them up.
		if (enabled) {
			try {
				await this.startServer(port)
				this.clearPortWarning()
			} catch (error) {
				this.handleStartFailure(error, port)
			}
		}
	}

	private log(line: string): void {
		this.outputChannel.appendLine(line)
	}

	/** Shows a status-bar warning for remote start problems (created lazily — only on failure). */
	private showPortWarning(port: number, message: string): void {
		if (!this.statusBarItem) {
			this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
			this.statusBarItem.command = "vscode.openOutput"
			this.statusBarItem.tooltip = "Zoo Remote — Details im Output-Channel"
		}
		this.statusBarItem.text = `$(warning) Zoo Remote :${port}`
		this.statusBarItem.name = message
		this.statusBarItem.show()
	}

	private clearPortWarning(): void {
		if (this.server?.isRunning) {
			this.statusBarItem?.hide()
		} else {
			this.statusBarItem?.dispose()
			this.statusBarItem = undefined
		}
	}
}

const PackageName = "zoo-code"

/** Small helper so catch blocks stay one-liners (no import needed). */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

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
