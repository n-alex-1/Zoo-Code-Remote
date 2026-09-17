import React, { useEffect } from "react"

import { AppProviders } from "../../../../playwright/AppProviders"
import RemoteControlSettings from "../RemoteControlSettings"

/**
 * Live state the story simulates after mount: server running with a token and
 * certificate fingerprint available — the surface users see first when they
 * enable Remote Control. Dispatched as a `remoteInfo` webview message so the
 * component renders its fully-populated state deterministically on every mount.
 */
const RUNNING_REMOTE_INFO = {
	type: "remoteInfo",
	remoteInfoPayload: {
		enabled: true,
		port: 8999,
		running: true,
		token: "tok-0123456789abcdef",
		fingerprint: "AB:CD:EF:01:23:45:67:89:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
		pairing: { windowOpen: false, paired: true },
	},
}

export function RemoteControlSettingsStory() {
	useEffect(() => {
		window.dispatchEvent(new MessageEvent("message", { data: RUNNING_REMOTE_INFO }))
	}, [])

	return (
		<AppProviders>
			<div
				data-testid="remote-control-story"
				className="w-full max-w-[488px] rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<RemoteControlSettings />
			</div>
		</AppProviders>
	)
}
