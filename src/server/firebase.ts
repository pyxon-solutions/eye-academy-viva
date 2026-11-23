import { existsSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Admin SDK. With a `demo-*` project id (the default) everything runs against the
 * local emulators and no credentials are needed. For a real project set
 * FIREBASE_PROJECT_ID plus a service-account key, either as a file
 * (GOOGLE_APPLICATION_CREDENTIALS, local) or inline JSON (FIREBASE_SERVICE_ACCOUNT,
 * hosting without a filesystem such as Vercel).
 */
export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-eye-academy";
const demo = PROJECT_ID.startsWith("demo-");

if (demo) {
	process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
	process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
}

function serviceAccount() {
	if (demo) return undefined;
	const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
	if (inline) return cert(JSON.parse(inline));
	const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (file && existsSync(file)) return cert(file);
	return undefined; // fall back to application default credentials
}

function credentialOption() {
	const credential = serviceAccount();
	return credential ? { credential } : {};
}

const existing = getApps()[0];
const app =
	existing ??
	initializeApp({
		projectId: PROJECT_ID,
		// Load the service-account key explicitly: tokens are then signed locally
		// instead of through the IAM Credentials API, which a fresh project lacks.
		// Omit the key entirely when there is no credential (emulators/ADC):
		// initializeApp rejects an explicit `credential: undefined`.
		...credentialOption(),
	});
export const adminAuth = getAuth(app);
// Settings can only be applied once per app (dev-server HMR re-evaluates this module).
// Optional fields (e.g. a turn without `findings`) are simply omitted.
export const db = getFirestore(app);
if (!existing) db.settings({ ignoreUndefinedProperties: true });

export class AuthError extends Error {}

/** Optional allow-list: comma-separated emails and/or @domains. Empty = anyone signed in. */
const ALLOWED = (process.env.ALLOWED_EMAILS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

export const isAllowed = (email: string | undefined) =>
	ALLOWED.length === 0 ||
	(!!email &&
		ALLOWED.some((a) =>
			a.startsWith("@")
				? email.toLowerCase().endsWith(a)
				: email.toLowerCase() === a,
		));

/** Verifies a Firebase ID token (and the allow-list) and returns the caller's uid. */
export async function requireUid(idToken: string): Promise<string> {
	let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
	try {
		decoded = await adminAuth.verifyIdToken(idToken);
	} catch {
		throw new AuthError("Not signed in");
	}
	if (!isAllowed(decoded.email))
		throw new AuthError(
			"This demo is limited to invited accounts. Ask the developer to add your email.",
		);
	return decoded.uid;
}
