# Remote Control (Android App)

Remote Control lets you monitor and operate Zoo Code from your phone. When enabled, the extension starts a local **HTTPS/WebSocket server** on your computer; the **Zoo Remote Android app** connects to it over the internet and shows:

- Current **task status**, active **mode**, and current **model**
- A **notification** when Zoo Code waits for input (tool approval, follow-up question) — you can approve, deny, or answer remotely
- Mode and model switching from the app

Only status metadata is transferred — **no file contents** of your workspace.

## Enabling Remote Control

1. Open **Settings → Remote Control**.
2. Toggle **Enable Remote Control** on. The server starts immediately (default port `8999`).
3. Optionally change **Port** (valid range 1024–65535). Changing it while enabled restarts the server on the new port.

The section shows live state: whether the server is running, the current access token, and the certificate fingerprint (SHA-256) of the self-signed TLS certificate.

## Pairing the app

Pairing transfers the token and certificate fingerprint to your phone automatically — no manual copying needed:

1. In **Settings → Remote Control**, press **Start pairing**. A one-shot window opens for **120 seconds**.
2. In the Zoo Remote app, enter only your computer's host/IP + port and press **Pairing**. The app fetches token and fingerprint on its own (`POST /api/pair`).
3. Once paired, the settings show "One device is paired."

### Resetting a pairing

**Reset (new token + certificate)** regenerates both the access token and the TLS certificate. Already linked devices must pair again afterwards — use this if you suspect the token leaked or want to re-pin the certificate on your phone.

You can always fall back to manual pairing: copy the **Access token** and **Certificate fingerprint** shown in Settings into the app's connection screen instead of using the pairing window.

## Security notes

- The server uses a **self-signed TLS certificate**. The Android app pins it via its SHA-256 fingerprint, so connections are protected against MITM once paired.
- TLS ≥ 1.2 is required; the WebSocket handshake has per-IP rate limiting.
- **Allowed client IPs** (`zoo-code.remote.allowedIps`): optional allowlist of IPv4/IPv6 addresses that may reach the server (empty = all allowed). Checked at socket level for both REST and WebSocket connections — useful when port-forwarding from a shared network.
- The remote API is token-authenticated; treat the access token like a password.

## Settings reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `zoo-code.remote.enabled` | boolean | `false` | Starts the local HTTPS/WebSocket server so the Zoo Remote app can connect. |
| `zoo-code.remote.port` | number | `8999` | TCP port for the remote control server (1024–65535). Changing it while enabled restarts the server. |
| `zoo-code.remote.allowedIps` | string[] | `[]` | Optional allowlist of client IPs; empty allows all. Checked at socket level for REST and WebSocket connections alike. |
