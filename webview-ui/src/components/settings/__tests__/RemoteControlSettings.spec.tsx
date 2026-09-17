// pnpm --filter @roo-code/vscode-webview exec vitest run src/components/settings/__tests__/RemoteControlSettings.spec.tsx

import { act, fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import RemoteControlSettings from "../RemoteControlSettings"

const postMessage = vi.fn()
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: any[]) => postMessage(...args),
	},
}))

// English translations for the remote section, mirroring webview-ui/src/i18n/locales/en/settings.json.
const t = (key: string) => {
	const translations: Record<string, string> = {
		"settings:sections.remote": "Remote Control",
		"settings:remote.enabled.label": "Enable Remote Control",
		"settings:remote.enabled.description":
			"Starts a local HTTPS/WebSocket server so the Zoo Remote Android app can see task status and approve/answer asks.",
		"settings:remote.port.label": "Port",
		"settings:remote.port.description":
			"TCP port for the remote control server (default: 8999). Changing it while enabled restarts the server on the new port.",
		"settings:remote.status.running": "Server running.",
		"settings:remote.status.starting": "Starting server…",
		"settings:remote.status.pairingOpen": 'Pairing window open — press "Pairing" in the app (120 s).',
		"settings:remote.status.paired": 'One device is paired. For a second device: "Reset".',
		"settings:remote.token.label": "Access token",
		"settings:remote.fingerprint.label": "Certificate fingerprint (SHA-256)",
		"settings:remote.copy": "Copy",
		"settings:remote.copied": "Copied!",
		"settings:remote.pairingHint":
			'In the Zoo Remote app enter only host/IP + port and press "Pairing" — the app fetches token and fingerprint on its own.',
		"settings:remote.pairing.title": "Link app (pairing)",
		"settings:remote.pairing.description":
			'"Start pairing" opens a 120-second window. In the Zoo Remote app enter only host/IP + port and press "Pairing" — token and certificate fingerprint are transferred automatically.',
		"settings:remote.pairing.start": "Start pairing",
		"settings:remote.pairing.reset": "Reset (new token + certificate)",
		"settings:remote.pairing.resetConfirm":
			"Regenerate token AND certificate? Already linked devices must re-pair afterwards.",
	}
	return translations[key] ?? key
}

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t }),
}))

const REMOTE_ENABLED_SETTING = "zoo-code.remote.enabled"
const REMOTE_PORT_SETTING = "zoo-code.remote.port"

interface RemoteInfoPayload {
	enabled: boolean
	port: number
	running: boolean
	token: string | null
	fingerprint: string | null
	pairing?: { windowOpen: boolean; paired: boolean }
}

function sendRemoteInfo(payload: RemoteInfoPayload) {
	return act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "remoteInfo", remoteInfoPayload: payload } }))
	})
}

const runningInfo = (overrides: Partial<RemoteInfoPayload> = {}): RemoteInfoPayload => ({
	enabled: true,
	port: 8999,
	running: true,
	token: "tok-12345678",
	fingerprint: "AB:CD:EF:01:23:45:67:89:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
	...overrides,
})

describe("RemoteControlSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
			configurable: true,
		})
	})

	it("requests both settings and the live remote state on mount", () => {
		render(<RemoteControlSettings />)

		expect(postMessage).toHaveBeenCalledWith({ type: "getVSCodeSetting", setting: REMOTE_ENABLED_SETTING })
		expect(postMessage).toHaveBeenCalledWith({ type: "getVSCodeSetting", setting: REMOTE_PORT_SETTING })
		expect(postMessage).toHaveBeenCalledWith({ type: "requestRemoteInfo" })
	})

	it("renders the section header and an unchecked enable checkbox by default", () => {
		render(<RemoteControlSettings />)

		expect(screen.getByText(t("settings:sections.remote"))).toBeInTheDocument()
		const checkbox = screen.getByTestId("remote-enabled-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)
		// Port input is disabled while remote control is off.
		const portInput = screen.getByTestId("remote-port-input") as HTMLInputElement
		expect(portInput.disabled).toBe(true)
	})

	it("sends updateVSCodeSetting when the enable checkbox is toggled", () => {
		render(<RemoteControlSettings />)
		const checkbox = screen.getByTestId("remote-enabled-checkbox") as HTMLInputElement

		fireEvent.click(checkbox)
		expect(postMessage).toHaveBeenCalledWith({ type: "updateVSCodeSetting", setting: REMOTE_ENABLED_SETTING, value: true })

		fireEvent.click(screen.getByTestId("remote-enabled-checkbox"))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "updateVSCodeSetting", setting: REMOTE_ENABLED_SETTING, value: false })
	})

	it("shows the starting status and placeholders before live info arrives", async () => {
		render(<RemoteControlSettings />)
		fireEvent.click(screen.getByTestId("remote-enabled-checkbox"))

		expect(await screen.findByText(t("settings:remote.status.starting"))).toBeInTheDocument()
		// Token/fingerprint render as "…" until remoteInfo arrives.
		const status = screen.getByTestId("remote-status")
		expect(status.querySelectorAll("code")).toHaveLength(2)
		expect((screen.getByTestId("remote-token-copy") as HTMLButtonElement).disabled).toBe(true)
		expect((screen.getByTestId("remote-fingerprint-copy") as HTMLButtonElement).disabled).toBe(true)
	})

	const committedPortUpdates = () =>
		postMessage.mock.calls.filter(
			([message]) => message?.type === "updateVSCodeSetting" && message?.setting === REMOTE_PORT_SETTING,
		)

	it("commits the port on blur, clamped to the valid range", () => {
		render(<RemoteControlSettings />)
		fireEvent.click(screen.getByTestId("remote-enabled-checkbox"))
		const portInput = screen.getByTestId("remote-port-input") as HTMLInputElement

		fireEvent.change(portInput, { target: { value: "80" } })
		fireEvent.blur(portInput)
		expect(committedPortUpdates()).toEqual([[{ type: "updateVSCodeSetting", setting: REMOTE_PORT_SETTING, value: 1024 }]])

		fireEvent.change(portInput, { target: { value: "99999" } })
		fireEvent.blur(portInput)
		expect(committedPortUpdates()).toEqual([
			[{ type: "updateVSCodeSetting", setting: REMOTE_PORT_SETTING, value: 1024 }],
			[{ type: "updateVSCodeSetting", setting: REMOTE_PORT_SETTING, value: 65535 }],
		])
	})

	it("commits the port on Enter and ignores non-numeric input", () => {
		render(<RemoteControlSettings />)
		fireEvent.click(screen.getByTestId("remote-enabled-checkbox"))
		const portInput = screen.getByTestId("remote-port-input") as HTMLInputElement

		fireEvent.change(portInput, { target: { value: "9100" } })
		fireEvent.keyDown(portInput, { key: "Enter" })
		expect(committedPortUpdates()).toEqual([[{ type: "updateVSCodeSetting", setting: REMOTE_PORT_SETTING, value: 9100 }]])

		fireEvent.change(portInput, { target: { value: "abc" } })
		fireEvent.keyDown(portInput, { key: "Enter" })
		expect(committedPortUpdates()).toHaveLength(1)
	})

	it("renders live token, fingerprint and pairing controls from remoteInfo", async () => {
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo())

		expect(screen.getByText(t("settings:remote.status.running"))).toBeInTheDocument()
		const checkbox = screen.getByTestId("remote-enabled-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
		expect((screen.getByTestId("remote-port-input") as HTMLInputElement).value).toBe("8999")

		const tokenCode = screen.getByText("tok-12345678")
		expect(tokenCode.closest("code")).toBeTruthy()
		expect(screen.getByText(runningInfo().fingerprint!)).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("remote-token-copy"))
		await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("tok-12345678"))
		expect(await screen.findByRole("button", { name: t("settings:remote.copied") })).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("remote-fingerprint-copy"))
		await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(runningInfo().fingerprint))
	})

	it("applies enabled/port values from vsCodeSetting messages", async () => {
		render(<RemoteControlSettings />)

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "vsCodeSetting", setting: REMOTE_ENABLED_SETTING, value: true } }),
			)
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "vsCodeSetting", setting: REMOTE_PORT_SETTING, value: 9012 } }),
			)
		})

		expect((screen.getByTestId("remote-enabled-checkbox") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByTestId("remote-port-input") as HTMLInputElement).value).toBe("9012")
	})

	it("starts pairing and sends the startRemotePairing message", async () => {
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo())

		fireEvent.click(screen.getByRole("button", { name: t("settings:remote.pairing.start") }))
		expect(postMessage).toHaveBeenCalledWith({ type: "startRemotePairing" })
	})

	it("shows the pairing-open state and disables reset while the window is open", async () => {
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo({ pairing: { windowOpen: true, paired: false } }))

		expect(screen.getByText(t("settings:remote.status.pairingOpen"))).toBeInTheDocument()
		expect((screen.getByTestId("remote-pairing-reset") as HTMLButtonElement).disabled).toBe(true)
	})

	it("shows the paired state when a device is linked and no window is open", async () => {
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo({ pairing: { windowOpen: false, paired: true } }))

		expect(screen.getByText(t("settings:remote.status.paired"))).toBeInTheDocument()
	})

	it("disables reset while the server is not running", async () => {
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo({ running: false, token: null, fingerprint: null }))

		expect((screen.getByTestId("remote-pairing-reset") as HTMLButtonElement).disabled).toBe(true)
	})

	it("resets pairing only after the confirmation dialog is accepted", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo())

		fireEvent.click(screen.getByTestId("remote-pairing-reset"))
		expect(confirmSpy).toHaveBeenCalledWith(t("settings:remote.pairing.resetConfirm"))
		expect(postMessage).not.toHaveBeenCalledWith({ type: "resetRemotePairing" })

		confirmSpy.mockReturnValue(true)
		fireEvent.click(screen.getByTestId("remote-pairing-reset"))
		expect(postMessage).toHaveBeenCalledWith({ type: "resetRemotePairing" })
	})

	it("copies the fingerprint and shows the copied state for both fields", async () => {
		render(<RemoteControlSettings />)
		await sendRemoteInfo(runningInfo())

		fireEvent.click(screen.getByTestId("remote-fingerprint-copy"))
		await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(runningInfo().fingerprint))
		expect(screen.getAllByRole("button", { name: t("settings:remote.copied") })).toHaveLength(1)
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})
