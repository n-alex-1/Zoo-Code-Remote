/**
 * One-shot pairing window for `POST /api/pair`.
 *
 * Instead of typing token + certificate fingerprint into the app by hand, the user presses
 * "Pairing starten" in the Settings tab (opens a 120 s one-shot window) and then "Pairing"
 * on the phone. The phone fetches `{ token, fingerprint }` via the unauthenticated pairing
 * endpoint and stores both — no manual copying needed.
 *
 * Rules:
 * - A window is opened by {@link openWindow} and self-closes after `durationMs`. Consuming it
 *   (a successful pair) closes it immediately.
 * - Without a rotation, once one device has paired the server rejects further attempts with
 *   `already_paired` — until "Zurücksetzen" rotates token + certificate (`openWindow(true)`),
 *   which clears the paired flag and opens a fresh window.
 */

/** Default pairing window duration: 120 s. */
export const REMOTE_PAIRING_WINDOW_MS = 120_000

/** Outcome of {@link RemotePairing.tryConsume}. */
export type PairingConsumeResult = "ok" | "no_window" | "already_paired"

/** Observable pairing state (also embedded in the `remoteInfo` webview payload). */
export interface RemotePairingState {
	/** A one-shot window is currently open — an app may call `POST /api/pair`. */
	windowOpen: boolean
	/** At least one device paired successfully since server start / last reset. */
	paired: boolean
}

export class RemotePairing {
	private windowOpen = false
	/** True when the current window was opened after a credential rotation (reset). */
	private windowRotated = false
	private paired = false
	private timer?: NodeJS.Timeout

	constructor(
		private readonly durationMs: number = REMOTE_PAIRING_WINDOW_MS,
		private readonly log?: (line: string) => void,
	) {}

	get state(): RemotePairingState {
		return { windowOpen: this.windowOpen, paired: this.paired }
	}

	/**
	 * Opens a one-shot pairing window. With `rotate = true` the caller has just rotated token +
	 * certificate (reset), so the "paired" flag is cleared and a new device may pair; without it,
	 * an already-paired server answers `already_paired` to further attempts.
	 */
	openWindow(rotate: boolean): void {
		if (this.timer) {
			clearTimeout(this.timer)
		}
		if (rotate) {
			this.paired = false
		}
		this.windowOpen = true
		this.windowRotated = rotate
		this.timer = setTimeout(() => {
			this.windowOpen = false
			this.log?.("Pairing window expired without a device pairing.")
		}, this.durationMs)
		// Don't keep the extension host alive just for the expiry timer.
		this.timer.unref?.()
	}

	/** Called by `POST /api/pair`: consumes the open window (if any) and reports why not otherwise. */
	tryConsume(): PairingConsumeResult {
		if (!this.windowOpen) {
			return "no_window"
		}
		if (this.paired && !this.windowRotated) {
			return "already_paired"
		}
		this.windowOpen = false
		this.paired = true
		return "ok"
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
	}
}
