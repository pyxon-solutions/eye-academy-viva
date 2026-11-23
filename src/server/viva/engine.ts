import type { Attempt, FindingLine, Turn } from "#/domain/attempt";
import {
	displayLine,
	type FindingResult,
	resolveRequest,
	speakResult,
	type Topic,
	toSpeech,
	type VivaCase,
} from "#/domain/case";
import type { Retriever } from "#/domain/reference";
import type { StructuredLLM } from "../llm";
import { generateFollowUp, safetyFacts } from "./followup";
import { parseIntent } from "./intent";
import { generateRevisionPoint } from "./revision";

export type Deps = {
	llm: StructuredLLM;
	vivaCase: VivaCase;
	catalogue: Topic[];
	retriever: Retriever;
	now?: () => number;
};

/**
 * When the trainee says something that is neither a finding request nor an
 * answer, the examiner nudges a little more specifically each time instead of
 * repeating one line. Deterministic: no model call.
 */
export const PROMPTS = [
	"Ask me for any findings you need, or tell me your diagnosis and management when you're ready.",
	"Let's stay with the patient. You could ask for the visual acuity, the pressures or the anterior chamber, for example.",
	"When you're ready, tell me what you think is going on and how you'd manage it.",
];
const promptFor = (attempt: Attempt) => {
	const asked = attempt.transcript.filter((t) => t.tag === "prompt").length;
	return PROMPTS[Math.min(asked, PROMPTS.length - 1)];
};
const CLOSING =
	"Thank you, that's the end of the viva. I've put one revision point from the reference note on your screen.";
const CLOSING_UNSUPPORTED =
	"Thank you, that's the end of the viva. I couldn't find support in the reference note for a revision point, and I've said so on your screen.";

export function newAttempt(
	uid: string,
	vivaCase: VivaCase,
	now = Date.now(),
): Attempt {
	return {
		uid,
		caseId: vivaCase.case_id,
		phase: "findings",
		createdAt: now,
		updatedAt: now,
		transcript: [
			{
				role: "examiner",
				tag: "opening",
				text: vivaCase.opening_prompt,
				speech: toSpeech(vivaCase.opening_prompt),
				at: now,
			},
		],
		revealed: [],
		answer: null,
		followUp: null,
		revision: null,
	};
}

const toLine = (r: FindingResult): FindingLine => ({
	findingId: r.kind === "not_in_case" ? null : r.finding.id,
	kind: r.kind,
	line: displayLine(r),
});

/**
 * Advances the viva by one trainee utterance. Pure apart from the injected LLM:
 * returns the next attempt state and the examiner turn to speak.
 */
export async function takeTurn(
	attempt: Attempt,
	utterance: string,
	deps: Deps,
): Promise<{ attempt: Attempt; reply: Turn }> {
	const now = deps.now ?? Date.now;
	if (attempt.phase === "completed") throw new Error("This viva has finished.");

	const trainee: Turn = { role: "trainee", text: utterance, at: now() };
	let reply: Turn;
	const next: Attempt = { ...attempt, revealed: [...attempt.revealed] };

	if (attempt.phase === "findings") {
		const intent = await parseIntent(deps.llm, deps.catalogue, utterance);

		if (intent.kind === "findings" && intent.requests.length > 0) {
			const results = intent.requests.flatMap((r) =>
				resolveRequest(deps.catalogue, r),
			);
			for (const r of results)
				if (r.kind !== "not_in_case" && !next.revealed.includes(r.finding.id))
					next.revealed.push(r.finding.id);
			const lines = results.map(toLine);
			reply = {
				role: "examiner",
				tag: "findings",
				text: lines.map((l) => l.line).join("\n"),
				speech: results.map(speakResult).join(" "),
				findings: lines,
				at: now(),
			};
		} else if (intent.kind === "answer") {
			const fu = await generateFollowUp(deps.llm, deps.vivaCase, utterance);
			next.answer = utterance;
			next.followUp = {
				question: fu.question,
				respondsTo: fu.responds_to,
				answer: null,
			};
			next.phase = "follow_up";
			reply = {
				role: "examiner",
				tag: "follow_up",
				text: fu.question,
				speech: fu.question,
				at: now(),
			};
		} else {
			const prompt = promptFor(attempt);
			reply = {
				role: "examiner",
				tag: "prompt",
				text: prompt,
				speech: prompt,
				at: now(),
			};
		}
	} else {
		// phase === "follow_up": whatever they say is their answer to the follow-up.
		const followUp = attempt.followUp;
		if (!followUp || !attempt.answer)
			throw new Error("Follow-up phase without a question");
		next.followUp = { ...followUp, answer: utterance };
		const rev = await generateRevisionPoint(deps.llm, deps.retriever, {
			answer: attempt.answer,
			followUpQuestion: followUp.question,
			followUpAnswer: utterance,
			context: {
				safetyFacts: safetyFacts(deps.vivaCase),
				allergies: deps.vivaCase.patient.allergies,
				// "Chlorphenamine 4 mg (over the counter)…" → "Chlorphenamine": doses dilute the query.
				medications: deps.vivaCase.patient.medications
					.map((m) => m.split(/\s+\d/)[0].trim())
					.join(", "),
				keyPoints: deps.vivaCase.examiner_notes.key_points,
			},
		});
		const retrievedPages = rev.retrieved.map((r) => r.page);
		next.revision = rev.supported
			? {
					supported: true,
					point: rev.point,
					page: rev.page,
					heading: rev.heading,
					excerpt: rev.excerpt,
					retrievedPages,
					chunkId: rev.chunkId,
					category: rev.category,
					retrieved: rev.retrieved,
				}
			: {
					supported: false,
					message: rev.message,
					reason: rev.reason,
					retrievedPages,
					retrieved: rev.retrieved,
				};
		next.phase = "completed";
		const closing = rev.supported ? CLOSING : CLOSING_UNSUPPORTED;
		reply = {
			role: "examiner",
			tag: "closing",
			text: closing,
			speech: closing,
			at: now(),
		};
	}

	next.transcript = [...attempt.transcript, trainee, reply];
	next.updatedAt = now();
	return { attempt: next, reply };
}
