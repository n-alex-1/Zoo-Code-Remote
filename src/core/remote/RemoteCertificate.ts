import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

import { generate } from "selfsigned"

import type { RemoteCertificateInfo } from "./types"

const CERT_FILE = "remote-cert.pem"
const KEY_FILE = "remote-key.pem"

/**
 * Create (or load) the self-signed certificate used for the remote server's TLS.
 *
 * On first start a certificate is generated with the `selfsigned` package and
 * persisted as PEM files inside `certDir` (globalStorageUri/remote). Subsequent
 * starts reuse the stored pair so the fingerprint stays stable across restarts.
 */
export async function loadOrCreateCertificate(certDir: string): Promise<RemoteCertificateInfo> {
	await fs.mkdir(certDir, { recursive: true })

	const certPath = path.join(certDir, CERT_FILE)
	const keyPath = path.join(certDir, KEY_FILE)

	try {
		const [certPem, keyPem] = await Promise.all([fs.readFile(certPath, "utf8"), fs.readFile(keyPath, "utf8")])
		return { certPem, keyPem, fingerprint: computeFingerprint(certPem) }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error
		}
	}

	const notAfter = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000) // ~10 years
	const pems = await generate(
		[{ name: "commonName", value: "localhost" }],
		{
			keySize: 2048,
			algorithm: "sha256",
			notAfterDate: notAfter,
			extensions: [
				{ name: "basicConstraints", cA: false },
				{ name: "keyUsage", digitalSignature: true, keyEncipherment: true },
				{
					name: "subjectAltName",
					altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }],
				},
			],
		},
	)

	const keyPem = pems.private
	await Promise.all([fs.writeFile(certPath, pems.cert, { mode: 0o600 }), fs.writeFile(keyPath, keyPem, { mode: 0o600 })])

	return { certPem: pems.cert, keyPem, fingerprint: computeFingerprint(pems.cert) }
}

/**
 * SHA-256 fingerprint of a PEM certificate (over its DER encoding), formatted
 * as colon-separated lowercase hex — the format users paste into the app for
 * TLS pinning.
 */
export function computeFingerprint(certPem: string): string {
	const der = pemToDer(certPem)
	return crypto.createHash("sha256").update(der).digest("hex").match(/.{1,2}/g)?.join(":") ?? ""
}

function pemToDer(pem: string): Buffer {
	const base64 = pem
		.replace(/-----BEGIN CERTIFICATE-----/, "")
		.replace(/-----END CERTIFICATE-----/, "")
		.replace(/\s+/g, "")
	return Buffer.from(base64, "base64")
}
