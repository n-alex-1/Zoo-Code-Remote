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

/** Best-effort client IP for rate limiting: X-Forwarded-For first hop, else socket address. */
export function clientIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"]
	if (typeof forwarded === "string" && forwarded.trim().length > 0) {
		return forwarded.split(",")[0].trim()
	}
	if (Array.isArray(forwarded) && forwarded.length > 0) {
		return String(forwarded[0]).split(",")[0].trim()
	}
	return req.socket.remoteAddress ?? "unknown"
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
