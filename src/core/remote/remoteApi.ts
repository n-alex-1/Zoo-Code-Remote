import net from "net"

import type { IncomingMessage, ServerResponse } from "http"

/** Max JSON request body size for all POST routes (contract: 16 KB). */
export const REMOTE_MAX_BODY_BYTES = 16 * 1024

/**
 * Minimal in-memory rate limiter: sliding window of one minute per client IP.
 * Not meant to be distributed or perfect — it just keeps a single misbehaving
 * peer from hammering the local server (contract: docs/architektur.md §1.2).
 */
export class RateLimiter {
	private readonly limitPerMinute: number
	/** ip → timestamps of requests within the current window. */
	private readonly hits = new Map<string, number[]>()
	private cleanupTimer?: ReturnType<typeof setInterval>

	constructor(limitPerMinute: number) {
		this.limitPerMinute = Math.floor(limitPerMinute)
	}

	/** Returns true when the request is allowed, false when rate-limited (429). */
	allow(key: string): boolean {
		if (this.limitPerMinute <= 0) {
			return true
		}

		const now = Date.now()
		const windowStart = now - 60_000
		const entries = this.hits.get(key)?.filter((ts) => ts > windowStart) ?? []
		if (entries.length >= this.limitPerMinute) {
			this.hits.set(key, entries)
			return false
		}

		entries.push(now)
		this.hits.set(key, entries)

		// Periodically drop stale keys so the map cannot grow unbounded.
		if (!this.cleanupTimer) {
			this.cleanupTimer = setInterval(() => this.sweep(), 60_000)
			this.cleanupTimer.unref?.()
		}
		return true
	}

	private sweep(): void {
		const cutoff = Date.now() - 60_000
		for (const [key, timestamps] of this.hits) {
			const fresh = timestamps.filter((ts) => ts > cutoff)
			if (fresh.length === 0) {
				this.hits.delete(key)
			} else {
				this.hits.set(key, fresh)
			}
		}
	}

	dispose(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = undefined
		}
	}
}

/** Best-effort client IP for rate limiting (XFF-aware budget): X-Forwarded-For first hop, else socket address. */
export function clientIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"]
	if (typeof forwarded === "string" && forwarded.trim().length > 0) {
		return normalizeClientIp(forwarded.split(",")[0].trim()) ?? "unknown"
	}
	if (Array.isArray(forwarded) && forwarded.length > 0) {
		return normalizeClientIp(String(forwarded[0]).split(",")[0].trim()) ?? "unknown"
	}
	const remote = req.socket.remoteAddress
	return remote ? (normalizeClientIp(remote) ?? "unknown") : "unknown"
}

/**
 * Peer IP straight from the TCP socket (`req.socket.remoteAddress`), normalized.
 * Unlike {@link clientIp}, this ignores X-Forwarded-For — required for the allowlist,
 * where a header-based value would be trivially spoofable by any client.
 */
export function socketIp(req: IncomingMessage): string {
	const remote = req.socket.remoteAddress
	return remote ? (normalizeClientIp(remote) ?? "unknown") : "unknown"
}

/**
 * Normalizes a client IP for allowlist comparison: strips IPv6 zone ids (`%eth0`),
 * lowercases hex, and expands IPv6 to its full 8-group form so `::1` and the fully
 * written loopback address compare equal. Returns undefined when the value is not an
 * IPv4/IPv6 literal (e.g. "unknown", hostname) — such peers are always rejected by a
 * non-empty allowlist.
 */
export function normalizeClientIp(raw: string): string | undefined {
	const withoutZone = raw.split("%")[0].trim().toLowerCase()
	if (!withoutZone || withoutZone === "unknown") {
		return undefined
	}
	const version = net.isIP(withoutZone)
	if (version === 4) {
		return withoutZone
	}
	if (version === 6) {
		// IPv4-mapped/compatible addresses (e.g. "::ffff:127.0.0.1" as reported by Node on Windows):
		// normalize to the embedded IPv4 form so allowlist entries like "127.0.0.1" match.
		const mapped = ipv6ToMappedIpv4(withoutZone)
		if (mapped) {
			return mapped
		}
		return expandIpv6(withoutZone) ?? withoutZone
	}
	return undefined
}

/** Returns the embedded IPv4 address for `::ffff:a.b.c.d` (mapped) / `::a.b.c.d` (compatible), else undefined. */
function ipv6ToMappedIpv4(address: string): string | undefined {
	const expanded = expandIpv6(address)
	if (!expanded) {
		return undefined
	}
	const groups = expanded.split(":")
	// Only the IPv4-mapped form (::ffff:a.b.c.d) is unambiguous; the deprecated compatible form
	// would mis-map e.g. ::1 (loopback) to 0.0.0.1, so it is intentionally not converted here.
	if (!groups.slice(0, 5).every((group) => group === "0") || groups[5] !== "ffff") {
		return undefined
	}
	const hi = parseInt(groups[6], 16)
	const lo = parseInt(groups[7], 16)
	if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
		return undefined
	}
	return `${Math.floor(hi / 256)}.${hi % 256}.${Math.floor(lo / 256)}.${lo % 256}`
}

/** Expands an IPv6 address to its full 8-group form (leading zeros stripped per group). Returns undefined on malformed input. */
function expandIpv6(address: string): string | undefined {
	const isValidGroup = (group: string) => /^[0-9a-f]{1,4}$/.test(group)
	const normalize = (groups: string[]) => groups.map((group) => parseInt(group, 16).toString(16)).join(":")

	// IPv4-mixed trailing notation (::ffff:1.2.3.4): convert the dotted quad to two hex groups first.
	let input = address
	const mixed = /^(.*:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input)
	if (mixed) {
		const octets = mixed[2].split(".").map(Number)
		if (!octets.every((value) => value >= 0 && value <= 255)) {
			return undefined
		}
		input = `${mixed[1] ?? ""}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
	}

	if (!input.includes("::")) {
		const groups = input.split(":")
		return groups.length === 8 && groups.every(isValidGroup) ? normalize(groups) : undefined
	}
	const parts = input.split("::")
	if (parts.length > 2) {
		return undefined // multiple "::"
	}
	const headGroups = parts[0] ? parts[0].split(":") : []
	const tailGroups = parts[1] ? parts[1].split(":") : []
	if (headGroups.includes("") || tailGroups.includes("")) {
		return undefined
	}
	if (headGroups.length + tailGroups.length > 7) {
		return undefined
	}
	const groups: string[] = [
		...headGroups,
		...Array(8 - headGroups.length - tailGroups.length).fill("0"),
		...tailGroups,
	]
	return groups.every(isValidGroup) ? normalize(groups) : undefined
}

/**
 * Builds a normalized allowlist lookup from `zoo-code.remote.allowedIps` entries.
 * Returns an empty set for an absent/empty list (= all IPs allowed). Invalid entries
 * are dropped and logged so one typo cannot silently lock everyone out.
 */
export function buildAllowedIpSet(
	allowedIps: readonly string[] | undefined,
	log?: (line: string) => void,
): Set<string> {
	const set = new Set<string>()
	for (const raw of allowedIps ?? []) {
		const trimmed = typeof raw === "string" ? raw.trim() : ""
		if (!trimmed) {
			continue
		}
		const normalized = normalizeClientIp(trimmed)
		if (normalized) {
			set.add(normalized)
		} else {
			log?.("[Zoo Remote] Ignoring invalid entry in remote.allowedIps: " + trimmed)
		}
	}
	return set
}

/** True when `ip` passes the allowlist (empty set = all allowed). */
export function isIpAllowed(ip: string | undefined, allowedIps: Set<string>): boolean {
	if (allowedIps.size === 0) {
		return true
	}
	const normalized = ip ? normalizeClientIp(ip) : undefined
	return normalized !== undefined && allowedIps.has(normalized)
}

/**
 * Reads and parses a JSON request body.
 * - rejects bodies over {@link REMOTE_MAX_BODY_BYTES} (413 is reported by the caller via `tooLarge`),
 * - rejects invalid JSON (`invalid_json`).
 */
export async function readJsonBody(
	req: IncomingMessage,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: "invalid_json" | "body_too_large" }> {
	const chunks: Buffer[] = []
	let size = 0

	for await (const chunk of req) {
		size += chunk.length
		if (size > REMOTE_MAX_BODY_BYTES) {
			return { ok: false, error: "body_too_large" }
		}
		chunks.push(chunk as Buffer)
	}

	if (chunks.length === 0) {
		return { ok: false, error: "invalid_json" }
	}

	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, error: "invalid_json" }
		}
		return { ok: true, value: parsed as Record<string, unknown> }
	} catch {
		return { ok: false, error: "invalid_json" }
	}
}

/** Sends a JSON response with the given status code. */
export function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
	res.end(payload)
}

/** Maps a failed action result to an HTTP response (409 for pending-ask conflicts, 400 otherwise). */
export function sendActionError(res: ServerResponse, error: string): void {
	const status = error === "no_pending_ask" || error === "no_active_task" ? 409 : 400
	sendJson(res, status, { ok: false, error })
}
