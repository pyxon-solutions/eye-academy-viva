/**
 * Smoke test of the *built* server against the real Firebase project.
 *
 *   NITRO_PRESET=node-server pnpm build && pnpm smoke
 *
 * Why it exists: two production failures only appeared once the app was bundled
 * and a real Google ID token was verified (a dependency needing __dirname, and a
 * CommonJS package require()-ing an ESM-only one). Neither shows up in the dev
 * server or with the emulators, whose tokens are unsigned.
 *
 * The server runs with --no-experimental-require-module, which disables
 * require() of ES modules the way Vercel's runtime loader does.
 *
 * Needs FIREBASE_PROJECT_ID, VITE_FIREBASE_API_KEY and a service account
 * (FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS). Creates one
 * throwaway user and attempt, and deletes both.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toJSON } from "seroval";

try {
	process.loadEnvFile(".env");
} catch {}

const SERVER_DIR = ".output/server";
const PORT = Number(process.env.SMOKE_PORT || 3123);
const BASE = `http://localhost:${PORT}`;

/** Throws so that `finally` still stops the server and deletes test data. */
function fail(msg: string): never {
	throw new Error(msg);
}

function abort(msg: string): never {
	console.error(`FAIL  ${msg}`);
	process.exit(1);
}

for (const k of ["FIREBASE_PROJECT_ID", "VITE_FIREBASE_API_KEY"])
	if (!process.env[k]) abort(`${k} is not set`);
if (!existsSync(join(SERVER_DIR, "index.mjs")))
	abort("No built server. Run `NITRO_PRESET=node-server pnpm build` first.");
// Refuse to run against a server we didn't start (e.g. one left over from a crash).
if (await fetch(BASE).then(() => true, () => false)) abort(`port ${PORT} is already in use`);

// The server-function id is a content hash; read it from the build rather than hard-coding it.
function serverFnId(name: string): string {
	const dir = join(SERVER_DIR, "_ssr");
	for (const f of readdirSync(dir)) {
		const m = readFileSync(join(dir, f), "utf8").match(
			new RegExp(`id: "([a-f0-9]{64})",\\s*name: "${name}"`),
		);
		if (m) return m[1];
	}
	fail(`server function ${name} not found in the build`);
}

async function callServerFn(id: string, data: unknown) {
	const res = await fetch(`${BASE}/_serverFn/${id}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-tsr-serverfn": "true",
			origin: BASE,
			"sec-fetch-site": "same-origin",
		},
		body: JSON.stringify(toJSON({ data })),
	});
	// The response is seroval JSON; errors use TanStack's own `$TSR/Error` plugin,
	// so read the two fields we need from the raw payload instead of deserialising.
	const raw = await res.text();
	const isError = raw.includes('"k":["error"]');
	const message = raw.match(/"message":\{"t":1,"s":"([^"]*)"/)?.[1];
	const createdId = raw.match(/"k":\["id","speechId"\],"v":\[\{"t":1,"s":"([^"]+)"/)?.[1];
	return { status: res.status, raw, error: isError ? { message: message ?? raw } : undefined, id: createdId };
}

async function waitForServer(server: ChildProcess) {
	for (let i = 0; i < 60; i++) {
		if (server.exitCode !== null) fail(`server exited with code ${server.exitCode}`);
		try {
			await fetch(BASE);
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	fail("server did not start");
}

const { adminAuth, db, PROJECT_ID } = await import("../src/server/firebase.ts");
if (PROJECT_ID.startsWith("demo-")) abort("FIREBASE_PROJECT_ID points at the emulator demo project");

const uid = `ci-smoke-${Date.now()}`;
let attemptId: string | undefined;
let serverLog = "";
const server = spawn(process.execPath, ["--no-experimental-require-module", "index.mjs"], {
	cwd: SERVER_DIR,
	env: {
		...process.env,
		PORT: String(PORT),
		// The server runs from .output/server, so a relative key path must be made absolute.
		...(process.env.GOOGLE_APPLICATION_CREDENTIALS
			? { GOOGLE_APPLICATION_CREDENTIALS: resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS) }
			: {}),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

try {
	await waitForServer(server);
	const startAttempt = serverFnId("startAttempt");

	// A real, signed ID token, so the JWKS verification path actually runs.
	const custom = await adminAuth.createCustomToken(uid);
	const exchange = (await (
		await fetch(
			`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.VITE_FIREBASE_API_KEY}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: custom, returnSecureToken: true }),
			},
		)
	).json()) as { idToken?: string };
	if (!exchange.idToken) fail("could not exchange the custom token for an ID token");

	const ok = await callServerFn(startAttempt, { idToken: exchange.idToken });
	if (ok.error) fail(`startAttempt with a real token: ${ok.error.message}`);
	attemptId = ok.id;
	if (!attemptId) fail(`startAttempt returned no id (HTTP ${ok.status})`);
	console.log(`PASS  startAttempt with a real ID token → attempt ${attemptId}`);

	const doc = (await db.collection("attempts").doc(attemptId).get()).data();
	if (doc?.uid !== uid || doc?.phase !== "findings") fail("attempt not written with the caller as owner");
	console.log("PASS  attempt saved in Firestore with the caller as owner");

	const bad = await callServerFn(startAttempt, { idToken: "not-a-token" });
	if (bad.error?.message !== "Not signed in") fail(`invalid token was not rejected: ${bad.raw.slice(0, 200)}`);
	console.log("PASS  invalid token rejected");
	console.log("Smoke test passed");
} catch (e) {
	console.error(`FAIL  ${(e as Error).message}`);
	if (serverLog.trim()) console.error(`--- server output ---\n${serverLog}`);
	process.exitCode = 1;
} finally {
	server.kill();
	if (attemptId) await db.collection("attempts").doc(attemptId).delete();
	await adminAuth.deleteUser(uid).catch(() => {});
	console.log("Cleaned up: server stopped, test user and attempt deleted");
}
