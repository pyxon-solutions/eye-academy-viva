import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	createUserWithEmailAndPassword,
	GoogleAuthProvider,
	signInWithEmailAndPassword,
	signInWithPopup,
	signInWithRedirect,
	signOut,
} from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import type { Attempt } from "#/domain/attempt";
import { idToken, useUser } from "#/lib/auth";
import { firebase, usingEmulators } from "#/lib/firebase";
import { startAttempt } from "#/server/viva.functions";

export const Route = createFileRoute("/")({ ssr: false, component: Home });

function Home() {
	const { user, loading } = useUser();
	if (loading) return <Shell>Loading…</Shell>;
	return <Shell>{user ? <Attempts uid={user.uid} email={user.displayName ?? user.email} /> : <SignIn />}</Shell>;
}

export function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-screen bg-slate-50 text-slate-900">
			<header className="border-b border-slate-200 bg-white">
				<div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
					<Link to="/" className="font-semibold text-indigo-950">
						eye<span className="font-normal">academy</span>{" "}
						<span className="text-slate-500 font-normal">· Practice viva</span>
					</Link>
					{usingEmulators && (
						<span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
							local emulators
						</span>
					)}
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
		</div>
	);
}

function SignIn() {
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function google() {
		setBusy(true);
		setError(null);
		const { auth } = firebase();
		const provider = new GoogleAuthProvider();
		provider.setCustomParameters({ prompt: "select_account" });
		try {
			await signInWithPopup(auth, provider);
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (code === "auth/popup-blocked") await signInWithRedirect(auth, provider);
			else if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request")
				setError((e as Error).message.replace("Firebase: ", ""));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mx-auto max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
			<h1 className="text-xl font-semibold">Sign in to practise</h1>
			<p className="text-sm text-slate-600">
				Your viva attempts are saved to your account and visible only to you.
			</p>
			<button
				type="button"
				onClick={google}
				disabled={busy}
				className="flex w-full items-center justify-center gap-3 rounded border border-slate-300 bg-white px-4 py-2.5 font-medium hover:bg-slate-50 disabled:opacity-50"
			>
				<GoogleIcon />
				{busy ? "Signing in…" : "Continue with Google"}
			</button>
			{error && <p className="text-sm text-red-700">{error}</p>}
			{usingEmulators && <EmulatorEmailSignIn />}
		</div>
	);
}

/** Local emulator only: email/password accounts for scripted end-to-end checks. */
function EmulatorEmailSignIn() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function submit(mode: "in" | "up") {
		setError(null);
		const { auth } = firebase();
		try {
			if (mode === "in") await signInWithEmailAndPassword(auth, email, password);
			else await createUserWithEmailAndPassword(auth, email, password);
		} catch (e) {
			setError((e as Error).message.replace("Firebase: ", ""));
		}
	}

	return (
		<details className="border-t border-slate-200 pt-3 text-sm">
			<summary className="cursor-pointer text-slate-500">Test account (local emulator only)</summary>
			<form
				className="mt-3 space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					submit("in");
				}}
			>
				<label className="block">
					Email
					<input
						className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
						type="email"
						required
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</label>
				<label className="block">
					Password
					<input
						className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
						type="password"
						required
						minLength={6}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</label>
				{error && <p className="text-red-700">{error}</p>}
				<div className="flex gap-2">
					<button type="submit" className="flex-1 rounded border border-slate-300 px-3 py-1.5">
						Sign in
					</button>
					<button type="button" onClick={() => submit("up")} className="flex-1 rounded border border-slate-300 px-3 py-1.5">
						Create account
					</button>
				</div>
			</form>
		</details>
	);
}

function GoogleIcon() {
	return (
		<svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
			<path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
			<path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
			<path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
			<path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
		</svg>
	);
}

function Attempts({ uid, email }: { uid: string; email: string | null }) {
	const navigate = useNavigate();
	const [attempts, setAttempts] = useState<(Attempt & { id: string })[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	useEffect(() => {
		// The uid filter is required by the security rules, not just a convenience.
		const q = query(collection(firebase().db, "attempts"), where("uid", "==", uid));
		return onSnapshot(
			q,
			(snap) =>
				setAttempts(
					snap.docs
						.map((d) => ({ id: d.id, ...(d.data() as Attempt) }))
						.sort((a, b) => b.createdAt - a.createdAt),
				),
			(e) => setError(e.message),
		);
	}, [uid]);

	async function start() {
		setStarting(true);
		try {
			const { id, speechId } = await startAttempt({ data: { idToken: await idToken() } });
			navigate({ to: "/viva/$attemptId", params: { attemptId: id }, search: { speak: speechId } });
		} catch (e) {
			setError((e as Error).message);
			setStarting(false);
		}
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Your vivas</h1>
					<p className="text-sm text-slate-500">Signed in as {email}</p>
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => signOut(firebase().auth)}
						className="rounded border border-slate-300 px-3 py-2 text-sm"
					>
						Sign out
					</button>
					<button
						type="button"
						onClick={start}
						disabled={starting}
						className="rounded bg-indigo-900 px-4 py-2 text-white disabled:opacity-50"
					>
						{starting ? "Starting…" : "Start a new viva"}
					</button>
				</div>
			</div>
			{error && <p className="text-sm text-red-700">{error}</p>}
			{attempts === null ? (
				<p className="text-slate-500">Loading…</p>
			) : attempts.length === 0 ? (
				<p className="text-slate-500">No attempts yet.</p>
			) : (
				<ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
					{attempts.map((a) => (
						<li key={a.id}>
							<Link
								to="/viva/$attemptId"
								params={{ attemptId: a.id }}
								className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
							>
								<span>
									{a.caseId} · {new Date(a.createdAt).toLocaleString()}
								</span>
								<span className="text-sm text-slate-500">
									{a.phase === "completed" ? "Completed" : "In progress"} · {a.revealed.length} findings
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
