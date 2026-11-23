import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Attempt } from "#/domain/attempt";
import { catalogue, vivaCase } from "#/domain/case";
import { retriever } from "#/domain/reference";
import { db, requireUid } from "./firebase";
import { openaiStructured, transcribe } from "./llm";
import { issueSpeech } from "./speech";
import { newAttempt, takeTurn } from "./viva/engine";

/**
 * Server functions. Every write to `attempts` happens here, after the ID token is
 * verified and ownership is checked; the browser can only read (firestore.rules).
 */

const attempts = () => db.collection("attempts");

/** Cost guards for a public demo running on one OpenAI key. */
const MAX_ATTEMPTS_PER_USER = Number(process.env.MAX_ATTEMPTS_PER_USER || 5);
const MAX_TURNS_PER_ATTEMPT = 40;

export const startAttempt = createServerFn({ method: "POST" })
	.validator(z.object({ idToken: z.string() }))
	.handler(async ({ data }) => {
		const uid = await requireUid(data.idToken);
		const existing = await attempts().where("uid", "==", uid).count().get();
		if (existing.data().count >= MAX_ATTEMPTS_PER_USER)
			throw new Error(`You've reached the limit of ${MAX_ATTEMPTS_PER_USER} attempts for this demo. Reopen an earlier one below.`);
		const attempt = newAttempt(uid, vivaCase);
		const ref = await attempts().add(attempt);
		return { id: ref.id, speechId: issueSpeech(attempt.transcript[0].speech ?? attempt.transcript[0].text) };
	});

export const transcribeTurn = createServerFn({ method: "POST" })
	.validator((form: FormData) => {
		const idToken = form.get("idToken");
		const audio = form.get("audio");
		if (typeof idToken !== "string" || !(audio instanceof File))
			throw new Error("Expected idToken and audio");
		return { idToken, audio };
	})
	.handler(async ({ data }) => {
		await requireUid(data.idToken);
		const t0 = performance.now();
		const text = await transcribe(data.audio);
		return { text, sttMs: Math.round(performance.now() - t0) };
	});

export const submitTurn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			idToken: z.string(),
			attemptId: z.string(),
			text: z.string().trim().min(1).max(2000),
			/** Client-side timings for this turn (e.g. recording stop → transcript). */
			timings: z.record(z.string(), z.number()).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const uid = await requireUid(data.idToken);
		const ref = attempts().doc(data.attemptId);
		const snap = await ref.get();
		const current = snap.data() as Attempt | undefined;
		// Same error for "missing" and "not yours": don't leak which attempt ids exist.
		if (!current || current.uid !== uid) throw new Error("Attempt not found");
		if (current.phase === "completed") throw new Error("This viva has finished");
		if (current.transcript.length >= MAX_TURNS_PER_ATTEMPT * 2)
			throw new Error("This viva has reached its turn limit. Start a new attempt from the home page.");

		const t0 = performance.now();
		const { attempt, reply } = await takeTurn(current, data.text, {
			llm: openaiStructured,
			vivaCase,
			catalogue,
			retriever,
		});
		const serverMs = Math.round(performance.now() - t0);
		reply.timings = { ...data.timings, serverMs };

		// Optimistic concurrency: reject if another tab advanced the viva meanwhile.
		await ref.update(
			{ ...attempt, transcript: [...attempt.transcript.slice(0, -1), reply] },
			{ lastUpdateTime: snap.updateTime },
		);
		return {
			reply,
			phase: attempt.phase,
			speechId: issueSpeech(reply.speech ?? reply.text),
		};
	});

/** Re-speak an examiner line from a saved attempt (e.g. after reopening it). */
export const speakLine = createServerFn({ method: "POST" })
	.validator(z.object({ idToken: z.string(), attemptId: z.string(), index: z.number().int().min(0) }))
	.handler(async ({ data }) => {
		const uid = await requireUid(data.idToken);
		const current = (await attempts().doc(data.attemptId).get()).data() as Attempt | undefined;
		if (!current || current.uid !== uid) throw new Error("Attempt not found");
		const turn = current.transcript[data.index];
		if (!turn || turn.role !== "examiner") throw new Error("No examiner line at that index");
		return { speechId: issueSpeech(turn.speech ?? turn.text) };
	});
