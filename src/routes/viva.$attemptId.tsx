import { createFileRoute, Link } from "@tanstack/react-router";
import { doc, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { Attempt, FindingLine, Turn } from "#/domain/attempt";
import { idToken, useUser } from "#/lib/auth";
import { firebase } from "#/lib/firebase";
import { usePlayer, useRecorder } from "#/lib/voice";
import { speakLine, submitTurn, transcribeTurn } from "#/server/viva.functions";
import { Shell } from "./index";

export const Route = createFileRoute("/viva/$attemptId")({
	ssr: false,
	validateSearch: z.object({ speak: z.string().optional() }),
	component: VivaPage,
});

/** Who holds the floor. Drives the status banner and which controls are enabled. */
type Floor =
	| "your_turn"
	| "listening"
	| "transcribing"
	| "thinking"
	| "speaking"
	| "finished";

/** Client-measured voice-turn timings, keyed by the examiner turn's transcript index. */
type Timing = {
	sttMs?: number;
	serverMs?: number;
	toFirstAudioMs?: number;
	totalMs?: number;
};

function VivaPage() {
	const { attemptId } = Route.useParams();
	const { speak } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { user, loading } = useUser();
	const [attempt, setAttempt] = useState<Attempt | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [floor, setFloor] = useState<Floor>("your_turn");
	const [timings, setTimings] = useState<Record<number, Timing>>({});
	const [typed, setTyped] = useState("");
	const recorder = useRecorder();
	const player = usePlayer();
	const bottom = useRef<HTMLDivElement>(null);

	// Live read straight from Firestore; the rules only let the owner see it.
	useEffect(() => {
		if (!user) return;
		return onSnapshot(
			doc(firebase().db, "attempts", attemptId),
			(snap) => {
				if (!snap.exists()) return setError("Attempt not found.");
				setAttempt(snap.data() as Attempt);
			},
			() => setError("Attempt not found."),
		);
	}, [user, attemptId]);

	useEffect(() => {
		if (attempt?.phase === "completed" && floor === "your_turn")
			setFloor("finished");
	}, [attempt?.phase, floor]);

	// Braces matter: newer Chrome returns a Promise from scrollIntoView, which React would treat as a cleanup.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the transcript grows or the floor changes
	useEffect(() => {
		bottom.current?.scrollIntoView({ behavior: "smooth" });
	}, [attempt?.transcript.length, floor]);

	const speakNow = useCallback(
		async (speechId: string) => {
			setFloor("speaking");
			const r = await player.play(speechId);
			setFloor((f) => (f === "speaking" ? "your_turn" : f));
			return r;
		},
		[player],
	);

	// Opening line after "Start a new viva": speak it once, then drop it from the URL.
	const spokeOpening = useRef(false);
	useEffect(() => {
		if (!speak || spokeOpening.current) return;
		spokeOpening.current = true;
		navigate({ search: {}, replace: true });
		speakNow(speak);
	}, [speak, speakNow, navigate]);

	/** One full turn: optional audio → transcript → examiner reply → examiner voice. */
	async function turn(
		input: { audio: File } | { text: string },
		tStop: number,
	) {
		setError(null);
		try {
			const token = await idToken();
			let text: string;
			let sttMs: number | undefined;
			if ("audio" in input) {
				setFloor("transcribing");
				const form = new FormData();
				form.set("idToken", token);
				form.set("audio", input.audio);
				const r = await transcribeTurn({ data: form });
				text = r.text;
				sttMs = Math.round(performance.now() - tStop);
				if (!text) {
					setError("I didn't catch that. Try again, or type your question.");
					setFloor("your_turn");
					return;
				}
			} else text = input.text;

			setFloor("thinking");
			const tSubmit = performance.now();
			const res = await submitTurn({
				data: {
					idToken: token,
					attemptId,
					text,
					timings: sttMs ? { sttMs } : undefined,
				},
			});
			const serverMs = Math.round(performance.now() - tSubmit);
			const index = (attempt?.transcript.length ?? 0) + 1;
			const nextFloor: Floor =
				res.phase === "completed" ? "finished" : "your_turn";

			setFloor("speaking");
			const { firstAudioAt } = await player.play(res.speechId);
			const timing: Timing = {
				sttMs,
				serverMs,
				toFirstAudioMs: firstAudioAt
					? Math.round(firstAudioAt - tSubmit - serverMs)
					: undefined,
				totalMs: firstAudioAt ? Math.round(firstAudioAt - tStop) : undefined,
			};
			setTimings((t) => ({ ...t, [index]: timing }));
			console.info("[voice turn]", { text, ...timing });
			setFloor(nextFloor);
		} catch (e) {
			setError((e as Error).message);
			setFloor(attempt?.phase === "completed" ? "finished" : "your_turn");
		}
	}

	async function toggleMic() {
		if (floor === "speaking") player.stop();
		if (recorder.recording) {
			const tStop = performance.now();
			const audio = await recorder.stop();
			if (audio) await turn({ audio }, tStop);
			else setFloor("your_turn");
		} else {
			await recorder.start();
			setFloor("listening");
		}
	}

	// Space bar toggles the mic (outside text inputs).
	const toggleRef = useRef(toggleMic);
	toggleRef.current = toggleMic;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.code !== "Space" || e.repeat) return;
			if ((e.target as HTMLElement).closest("input, textarea, button")) return;
			e.preventDefault();
			toggleRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const revealed = useMemo(
		() => revealedFindings(attempt?.transcript ?? []),
		[attempt?.transcript],
	);

	if (loading) return <Shell>Loading…</Shell>;
	if (!user)
		return (
			<Shell>
				<Link to="/" className="text-indigo-800 underline">
					Sign in
				</Link>{" "}
				to continue.
			</Shell>
		);
	if (error && !attempt)
		return (
			<Shell>
				<p className="text-red-700">{error}</p>
			</Shell>
		);
	if (!attempt) return <Shell>Loading…</Shell>;

	const busy = floor === "transcribing" || floor === "thinking";
	const canSpeak =
		floor === "your_turn" || floor === "listening" || floor === "speaking";

	return (
		<Shell>
			<div className="grid gap-6 lg:grid-cols-[1fr_320px]">
				<section className="space-y-4">
					<StatusBanner
						floor={floor}
						phase={attempt.phase}
						onSkip={player.stop}
					/>

					<ol className="space-y-3">
						{attempt.transcript.map((t, i) => (
							<TurnBubble
								key={`${t.role}-${t.at}`}
								turn={t}
								timing={timings[i]}
								onReplay={
									t.role === "examiner" && !busy && !recorder.recording
										? async () => {
												const { speechId } = await speakLine({
													data: {
														idToken: await idToken(),
														attemptId,
														index: i,
													},
												});
												speakNow(speechId);
											}
										: undefined
								}
							/>
						))}
					</ol>

					{attempt.revision && <RevisionCard revision={attempt.revision} />}
					{error && <p className="text-sm text-red-700">{error}</p>}

					{attempt.phase !== "completed" && (
						<div className="sticky bottom-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-md">
							<div className="flex items-center gap-4">
								<button
									type="button"
									onClick={toggleMic}
									disabled={!canSpeak}
									aria-pressed={recorder.recording}
									className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-white transition disabled:opacity-40 ${
										recorder.recording
											? "animate-pulse bg-red-600"
											: "bg-emerald-600 hover:bg-emerald-700"
									}`}
								>
									<MicIcon />
									<span className="sr-only">
										{recorder.recording ? "Stop and send" : "Start speaking"}
									</span>
								</button>
								<p className="text-sm text-slate-600">
									{recorder.recording
										? "Listening. Tap again (or press Space) when you've finished."
										: attempt.phase === "follow_up"
											? "Answer the examiner's follow-up question."
											: "Tap (or press Space) and ask for a finding, e.g. “What are the pressures?”. Give your diagnosis and management when ready."}
								</p>
							</div>
							{recorder.error && (
								<p className="text-sm text-red-700">{recorder.error}</p>
							)}
							<form
								className="flex gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									const text = typed.trim();
									if (!text || busy) return;
									setTyped("");
									turn({ text }, performance.now());
								}}
							>
								<input
									className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
									placeholder="…or type instead"
									value={typed}
									disabled={busy || recorder.recording}
									onChange={(e) => setTyped(e.target.value)}
								/>
								<button
									type="submit"
									disabled={busy || recorder.recording || !typed.trim()}
									className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
								>
									Send
								</button>
							</form>
						</div>
					)}
					<div ref={bottom} />
				</section>

				<aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
					<h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
						Revealed findings
					</h2>
					{revealed.length === 0 ? (
						<p className="text-sm text-slate-500">Nothing asked for yet.</p>
					) : (
						<ul className="space-y-2">
							{revealed.map((f) => (
								<li
									key={f.findingId}
									className={`rounded-lg border px-3 py-2 text-sm ${
										f.kind === "available"
											? "border-slate-200 bg-white"
											: "border-amber-200 bg-amber-50 text-amber-900"
									}`}
								>
									{f.line}
								</li>
							))}
						</ul>
					)}
				</aside>
			</div>
		</Shell>
	);
}

/** Unique findings in the order first revealed; "not in case" requests are not findings. */
function revealedFindings(transcript: Turn[]): FindingLine[] {
	const seen = new Map<string, FindingLine>();
	for (const t of transcript)
		for (const f of t.findings ?? [])
			if (f.findingId && !seen.has(f.findingId)) seen.set(f.findingId, f);
	return [...seen.values()];
}

const BANNER: Record<Floor, { text: string; cls: string }> = {
	your_turn: {
		text: "Your turn: speak when ready",
		cls: "bg-emerald-50 border-emerald-300 text-emerald-900",
	},
	listening: {
		text: "Listening…",
		cls: "bg-red-50 border-red-300 text-red-900",
	},
	transcribing: {
		text: "Got it, transcribing…",
		cls: "bg-slate-100 border-slate-300 text-slate-700",
	},
	thinking: {
		text: "Examiner is responding…",
		cls: "bg-amber-50 border-amber-300 text-amber-900",
	},
	speaking: {
		text: "Examiner is speaking",
		cls: "bg-indigo-50 border-indigo-300 text-indigo-900",
	},
	finished: {
		text: "Viva complete",
		cls: "bg-slate-100 border-slate-300 text-slate-700",
	},
};

function StatusBanner({
	floor,
	phase,
	onSkip,
}: {
	floor: Floor;
	phase: Attempt["phase"];
	onSkip: () => void;
}) {
	const b =
		phase === "completed" && floor === "your_turn"
			? BANNER.finished
			: BANNER[floor];
	return (
		<output
			aria-live="polite"
			className={`flex items-center justify-between rounded-xl border px-4 py-3 font-medium ${b.cls}`}
		>
			<span className="flex items-center gap-2">
				<span
					className={`h-2.5 w-2.5 rounded-full bg-current ${floor === "listening" || floor === "speaking" ? "animate-pulse" : ""}`}
				/>
				{b.text}
			</span>
			{floor === "speaking" && (
				<button type="button" onClick={onSkip} className="text-sm underline">
					Skip
				</button>
			)}
		</output>
	);
}

function TurnBubble({
	turn,
	timing,
	onReplay,
}: {
	turn: Turn;
	timing?: Timing;
	onReplay?: () => void;
}) {
	const examiner = turn.role === "examiner";
	return (
		<li className={`flex ${examiner ? "justify-start" : "justify-end"}`}>
			<div
				className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
					examiner
						? "border border-slate-200 bg-white"
						: "bg-indigo-900 text-white"
				}`}
			>
				<div className="mb-1 flex items-center gap-2 text-xs opacity-60">
					{examiner ? "Examiner" : "You"}
					{onReplay && (
						<button
							type="button"
							onClick={onReplay}
							className="underline"
							title="Hear this again"
						>
							replay
						</button>
					)}
				</div>
				{turn.findings ? (
					<ul className="space-y-1">
						{turn.findings.map((f) => (
							<li
								key={f.findingId ?? f.line}
								className={f.kind === "available" ? "" : "text-amber-800"}
							>
								{f.line}
							</li>
						))}
					</ul>
				) : (
					<p className="whitespace-pre-line">{turn.text}</p>
				)}
				{timing?.totalMs !== undefined && (
					<p className="mt-2 text-[11px] text-slate-400">
						voice turn {fmt(timing.totalMs)} (
						{timing.sttMs !== undefined &&
							`speech-to-text ${fmt(timing.sttMs)} · `}
						examiner {fmt(timing.serverMs)} · voice start{" "}
						{fmt(timing.toFirstAudioMs)})
					</p>
				)}
			</div>
		</li>
	);
}

const fmt = (ms?: number) =>
	ms === undefined ? "–" : `${(ms / 1000).toFixed(1)}s`;

function RevisionCard({
	revision,
}: {
	revision: NonNullable<Attempt["revision"]>;
}) {
	if (!revision.supported)
		return (
			<div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
				<h2 className="mb-1 font-semibold">Revision point</h2>
				<p>{revision.message}</p>
				<p className="mt-2 text-xs opacity-70">
					Pages searched: {revision.retrievedPages.join(", ") || "none"}
				</p>
			</div>
		);
	return (
		<div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm">
			<h2 className="mb-2 font-semibold text-indigo-950">Revision point</h2>
			<p className="text-slate-900">{revision.point}</p>
			<blockquote className="mt-3 border-l-4 border-indigo-300 pl-3 italic text-slate-700">
				“{revision.excerpt}”
			</blockquote>
			<p className="mt-2 text-xs text-slate-500">
				Eye Academy reference note, page {revision.page} · {revision.heading}
			</p>
		</div>
	);
}

function MicIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			className="h-7 w-7"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			aria-hidden="true"
		>
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
		</svg>
	);
}
