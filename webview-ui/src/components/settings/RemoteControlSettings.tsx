import { useCallback, useEffect, useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEvent, useMount } from "react-use"

import type { ExtensionMessage } from "@roo-code/types"

import { Button, Input } from "@/components/ui"
import { cn } from "@/lib/utils"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"

type RemoteInfo = {
	enabled: boolean
	port: number
	running: boolean
	token: string | null
	fingerprint: string | null
	pairing?: {
		windowOpen: boolean
		paired: boolean
	}
}

const REMOTE_ENABLED_SETTING = "zoo-code.remote.enabled"
const REMOTE_PORT_SETTING = "zoo-code.remote.port"

/**
 * Settings → "Remote Control": toggle + port for the local HTTPS/WebSocket server,
 * plus token & certificate fingerprint (for pairing with the Zoo Remote app).
 *
 * The enabled/port values are written through the existing `updateVSCodeSetting`
 * message; live state (running/token/fingerprint) arrives via `remoteInfo`.
 */
export const RemoteControlSettings = ({ className, ...props }: { className?: string }) => {
	const { t } = useAppTranslation()

	const [enabled, setEnabled] = useState<boolean>(false)
	const [portInput, setPortInput] = useState<string>("")
	const [info, setInfo] = useState<RemoteInfo | null>(null)
	const [copiedField, setCopiedField] = useState<"token" | "fingerprint" | null>(null)

	useMount(() => {
		vscode.postMessage({ type: "getVSCodeSetting", setting: REMOTE_ENABLED_SETTING })
		vscode.postMessage({ type: "getVSCodeSetting", setting: REMOTE_PORT_SETTING })
		vscode.postMessage({ type: "requestRemoteInfo" })
	})

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "vsCodeSetting":
				if (message.setting === REMOTE_ENABLED_SETTING) {
					setEnabled(message.value === true)
				} else if (message.setting === REMOTE_PORT_SETTING && typeof message.value === "number") {
					setPortInput(String(message.value))
				}
				break
			case "remoteInfo":
				if (message.remoteInfoPayload) {
					const payload = message.remoteInfoPayload as RemoteInfo
					setInfo(payload)
					setEnabled(payload.enabled)
					setPortInput(String(payload.port))
				}
				break
			default:
				break
		}
	}, [])

	useEvent("message", onMessage)

	useEffect(() => {
		if (!copiedField) {
			return
		}
		const timer = setTimeout(() => setCopiedField(null), 1500)
		return () => clearTimeout(timer)
	}, [copiedField])

	const handleToggle = (checked: boolean) => {
		setEnabled(checked)
		vscode.postMessage({ type: "updateVSCodeSetting", setting: REMOTE_ENABLED_SETTING, value: checked })
	}

	const commitPort = () => {
		const parsed = Number.parseInt(portInput, 10)
		if (Number.isNaN(parsed)) {
			return
		}
		const clamped = Math.min(Math.max(parsed, 1024), 65535)
		vscode.postMessage({ type: "updateVSCodeSetting", setting: REMOTE_PORT_SETTING, value: clamped })
	}

	const copyToClipboard = async (field: "token" | "fingerprint") => {
		const value = field === "token" ? info?.token : info?.fingerprint
		if (!value) {
			return
		}
		try {
			await navigator.clipboard.writeText(value)
			setCopiedField(field)
		} catch (error) {
			console.error("Failed to copy to clipboard:", error)
		}
	}

	const isRunning = info?.running ?? false
	const pairing = info?.pairing
	const pairingWindowOpen = pairing?.windowOpen === true
	const paired = pairing?.paired === true

	const handleStartPairing = () => {
		vscode.postMessage({ type: "startRemotePairing" })
	}

	const handleResetPairing = () => {
		if (typeof window !== "undefined" && !window.confirm(t("settings:remote.pairing.resetConfirm"))) {
			return
		}
		vscode.postMessage({ type: "resetRemotePairing" })
	}

	return (
		<div className={cn("flex flex-col", className)} {...props}>
			<SectionHeader>{t("settings:sections.remote")}</SectionHeader>

			<Section>
				<div className="flex flex-col gap-4">
					{/* Enable / disable */}
					<VSCodeCheckbox
						checked={enabled}
						onChange={(e: any) => handleToggle(e.target.checked)}
						data-testid="remote-enabled-checkbox">
						<span className="font-medium">{t("settings:remote.enabled.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm pl-6">
						{t("settings:remote.enabled.description")}
					</div>

					{/* Port selection */}
					<div className="flex flex-col gap-1 pl-6">
						<label htmlFor="remote-port-input" className="font-medium">
							{t("settings:remote.port.label")}
						</label>
						<Input
							id="remote-port-input"
							type="number"
							min={1024}
							max={65535}
							value={portInput}
							disabled={!enabled}
							onChange={(e) => setPortInput(e.target.value)}
							onBlur={commitPort}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									commitPort()
								}
							}}
							data-testid="remote-port-input"
						/>
						<div className="text-vscode-descriptionForeground text-sm">
							{t("settings:remote.port.description")}
						</div>
					</div>

					{/* Live status */}
					{enabled && (
						<div className="flex flex-col gap-3 pl-6" data-testid="remote-status">
							<div className="text-sm font-medium">
								{isRunning ? t("settings:remote.status.running") : t("settings:remote.status.starting")}
							</div>

							<div className="flex flex-col gap-1">
								<label className="font-medium text-sm">{t("settings:remote.token.label")}</label>
								<div className="flex items-center gap-2">
									<code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-vscode-textCodeBlock-background px-2 py-1 text-xs">
										{info?.token ?? "…"}
									</code>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => copyToClipboard("token")}
										disabled={!info?.token}
										data-testid="remote-token-copy">
										{copiedField === "token" ? t("settings:remote.copied") : t("settings:remote.copy")}
									</Button>
								</div>
							</div>

							<div className="flex flex-col gap-1">
								<label className="font-medium text-sm">{t("settings:remote.fingerprint.label")}</label>
								<div className="flex items-center gap-2">
									<code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-vscode-textCodeBlock-background px-2 py-1 text-xs">
										{info?.fingerprint ?? "…"}
									</code>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => copyToClipboard("fingerprint")}
										disabled={!info?.fingerprint}
										data-testid="remote-fingerprint-copy">
										{copiedField === "fingerprint" ? t("settings:remote.copied") : t("settings:remote.copy")}
									</Button>
								</div>
							</div>

							{/* Pairing (Session 9b): one-shot window instead of copying token + fingerprint */}
							<div className="flex flex-col gap-2 rounded border border-vscode-widget-border bg-vscode-editor-background p-3" data-testid="remote-pairing">
								<div className="text-sm font-medium">{t("settings:remote.pairing.title")}</div>
								<div className="text-vscode-descriptionForeground text-sm">{t("settings:remote.pairing.description")}</div>
	
								{pairingWindowOpen && (
									<div className="rounded bg-vscode-badge-background px-2 py-1 text-xs text-vscode-badge-foreground">
										{t("settings:remote.status.pairingOpen")}
									</div>
								)}
								{!pairingWindowOpen && paired && (
									<div className="text-vscode-descriptionForeground text-sm">{t("settings:remote.status.paired")}</div>
								)}
	
								<div className="flex flex-wrap items-center gap-2">
									<Button variant="primary" size="sm" onClick={handleStartPairing} data-testid="remote-pairing-start">
										{t("settings:remote.pairing.start")}
									</Button>
									<Button variant="secondary" size="sm" onClick={handleResetPairing} disabled={!isRunning || pairingWindowOpen} data-testid="remote-pairing-reset">
										{t("settings:remote.pairing.reset")}
									</Button>
								</div>
	
								<div className="text-vscode-descriptionForeground text-xs">{t("settings:remote.pairingHint")}</div>
							</div>
						</div>
					)}
				</div>
			</Section>
		</div>
	)
}

export default RemoteControlSettings
