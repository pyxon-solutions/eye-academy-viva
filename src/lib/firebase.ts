import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, connectAuthEmulator, getAuth } from "firebase/auth";
import {
	connectFirestoreEmulator,
	type Firestore,
	getFirestore,
} from "firebase/firestore";

/**
 * Browser Firebase. Without VITE_FIREBASE_* config it talks to the local
 * emulators under the `demo-eye-academy` project (see `pnpm emulators`).
 */
const env = import.meta.env;
const real = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID);

const config = real
	? {
			apiKey: env.VITE_FIREBASE_API_KEY,
			authDomain: authDomain(),
			projectId: env.VITE_FIREBASE_PROJECT_ID,
			appId: env.VITE_FIREBASE_APP_ID,
		}
	: {
			apiKey: "demo-key",
			authDomain: "localhost",
			projectId: "demo-eye-academy",
		};

/**
 * Deployed: use our own host as the auth domain; `/__/auth/*` is proxied to
 * firebaseapp.com (see vite.config.ts), so the Google sign-in handler is
 * same-site and survives third-party storage partitioning.
 * Local dev: the default firebaseapp.com domain (popup sign-in works there).
 */
function authDomain(): string {
	if (typeof window === "undefined") return env.VITE_FIREBASE_AUTH_DOMAIN;
	const { hostname, host } = window.location;
	return hostname === "localhost" || hostname === "127.0.0.1"
		? env.VITE_FIREBASE_AUTH_DOMAIN
		: host;
}

let cached: { app: FirebaseApp; auth: Auth; db: Firestore } | undefined;

/** Lazily initialised, browser only (routes using it are `ssr: false`). */
export function firebase() {
	if (cached) return cached;
	const existing = getApps()[0];
	const app = existing ?? initializeApp(config);
	const auth = getAuth(app);
	const db = getFirestore(app);
	if (!real && !existing) {
		connectAuthEmulator(auth, "http://127.0.0.1:9099", {
			disableWarnings: true,
		});
		connectFirestoreEmulator(db, "127.0.0.1", 8080);
	}
	cached = { app, auth, db };
	return cached;
}

export const usingEmulators = !real;
