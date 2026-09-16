import crypto from "crypto"

/**
 * Bearer-token auth for the remote server.
 *
 * The token is generated once (32 random bytes, hex) and persisted in VS Code
 * SecretStorage by the caller; verification uses a constant-time compare so a
 * wrong token does not leak timing information over the network.
 */

/** Generate a new random bearer token (64 hex chars). */
export function generateRemoteToken(): string {
	return crypto.randomBytes(32).toString("hex")
}

/** Constant-time comparison of two tokens; false on empty input. */
export function verifyRemoteToken(expected: string | null | undefined, provided: string | null | undefined): boolean {
	if (!expected || !provided) {
		return false
	}
	// Hash both sides to a fixed 32-byte digest so timingSafeEqual always applies,
	// regardless of token length differences.
	const expectedDigest = crypto.createHash("sha256").update(String(expected), "utf8").digest()
	const providedDigest = crypto.createHash("sha256").update(String(provided), "utf8").digest()

	try {
		return crypto.timingSafeEqual(expectedDigest, providedDigest)
	} catch (error) {
		console.error("[RemoteAuth] timingSafeEqual failed:", error instanceof Error ? error.message : String(error))
		return false
	}
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
	if (!authorizationHeader) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim())
	return match?.[1]?.trim() || null
}
