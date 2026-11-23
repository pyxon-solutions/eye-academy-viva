import { z } from "zod";
import {
	chunkHeading,
	excerptIsVerbatim,
	type Retriever,
} from "#/domain/reference";
import { MODELS, type StructuredLLM } from "../llm";

export type RevisionInput = {
	answer: string;
	followUpQuestion: string;
	followUpAnswer: string;
	/** What a safe, complete answer must account for; lets the point target the most important gap. */
	context?: {
		safetyFacts: string;
		allergies: string;
		/** Drug names only (no doses), e.g. "Amlodipine, Chlorphenamine". */
		medications: string;
		keyPoints: string[];
	};
};

/** Everything the check write-up needs: what was retrieved, what was cited, and whether it held up. */
export type RevisionResult =
	| {
			supported: true;
			/** Why this point won: its category, ranked by PRIORITY. */
			category: Category;
			point: string;
			page: number;
			heading: string;
			chunkId: string;
			excerpt: string;
			retrieved: {
				chunkId: string;
				page: number;
				heading: string;
				score: number;
			}[];
	  }
	| {
			supported: false;
			message: string;
			/** Why it was rejected: the model found nothing, or its citation failed verification. */
			reason: "no_support" | "citation_not_verbatim" | "chunk_not_retrieved";
			retrieved: {
				chunkId: string;
				page: number;
				heading: string;
				score: number;
			}[];
	  };

/**
 * The model lists candidate points and classifies each one; the code, not the
 * model, decides which wins (see PRIORITY). Models are more reliable at labelling
 * individual items than at following a ranking rule across them.
 */
export const CATEGORIES = [
	"unsafe_drug_for_this_patient",
	"precipitating_drug_left_running",
	"missed_key_point",
	"incorrect_statement",
	"reinforce_correct_point",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Lower wins. Patient safety first; reinforcement only when nothing needs correcting. */
export const PRIORITY: Record<Category, number> = {
	unsafe_drug_for_this_patient: 0,
	precipitating_drug_left_running: 1,
	missed_key_point: 2,
	incorrect_statement: 3,
	reinforce_correct_point: 4,
};

const CandidateSchema = z.object({
	category: z.enum(CATEGORIES),
	/** True when the trainee's own words already cover this; such candidates are dropped. */
	already_in_trainee_answer: z.boolean(),
	chunk_id: z.string(),
	excerpt: z.string(),
	point: z.string(),
});
type Candidate = z.infer<typeof CandidateSchema>;

const RevisionSchema = z.object({ candidates: z.array(CandidateSchema) });

const NO_SUPPORT =
	"I couldn't find a passage in the reference note that supports a revision point on your answer, so I won't make one up.";

export const K = 5;
/** Passages reserved per safety query, on top of the K fused ones. */
export const SAFETY_K = 2;

/**
 * Retrieval queries, fused by rank: the follow-up exchange (short and specific)
 * and the trainee's main answer.
 */
export const retrievalQueries = (i: RevisionInput) => [
	`${i.followUpQuestion} ${i.followUpAnswer}`,
	i.answer,
];

/**
 * Short, focused queries for what a safe plan must account for: the patient's
 * allergies against the drugs in their answer, and their current drugs as
 * possible triggers. Their top passages get reserved slots, because in a fused
 * ranking a passage that matches only one query loses to ones matching several.
 */
export const safetyQueries = (i: RevisionInput) =>
	i.context
		? [
				`${i.context.allergies} allergy check before giving ${i.answer}`,
				`drugs that can trigger angle closure: ${i.context.medications}`,
			]
		: [];

export function retrievePassages(retriever: Retriever, input: RevisionInput) {
	const hits = retriever.searchMany(retrievalQueries(input), K);
	for (const q of safetyQueries(input))
		for (const h of retriever.search(q, SAFETY_K))
			if (!hits.some((x) => x.chunk.id === h.chunk.id)) hits.push(h);
	return hits;
}

export async function generateRevisionPoint(
	llm: StructuredLLM,
	retriever: Retriever,
	input: RevisionInput,
): Promise<RevisionResult> {
	const hits = retrievePassages(retriever, input);
	const retrieved = hits.map((h) => ({
		chunkId: h.chunk.id,
		page: h.chunk.page,
		heading: chunkHeading(h.chunk),
		score: Math.round(h.score * 100) / 100,
	}));
	if (hits.length === 0)
		return {
			supported: false,
			reason: "no_support",
			message: NO_SUPPORT,
			retrieved,
		};

	const passages = hits
		.map(
			(h) =>
				`<passage id="${h.chunk.id}" page="${h.chunk.page}" heading="${chunkHeading(h.chunk)}">\n${h.chunk.blocks.join("\n")}\n</passage>`,
		)
		.join("\n\n");

	const instructions = `You help write ONE revision point for an ophthalmology trainee after a practice viva.
Use ONLY the passages provided; no outside knowledge.

List up to 4 candidate points about the trainee's answers, each supported by ONE passage:
- category:
  - unsafe_drug_for_this_patient: their plan gives a drug this patient is allergic to, or one that needs a check (given the case facts) that they did not mention.
  - precipitating_drug_left_running: one of the patient's current drugs can precipitate the condition and they did not say to stop it.
  - missed_key_point: an important step or fact (see the examiner's key points) they left out.
  - incorrect_statement: something they said that the passage contradicts.
  - reinforce_correct_point: something they got right that the passage supports.
- already_in_trainee_answer: true only if the TRAINEE's own words (their answer or their reply) already cover it, e.g. they said to stop that drug. What the EXAMINER asked does not count: if the examiner raised the allergy and the trainee didn't address it, it is not covered. Be literal.
- chunk_id: the id of the passage that supports it.
- excerpt: one sentence or clause copied EXACTLY, character for character, from that passage (max 35 words). Do not shorten, reorder or join sentences. Use "..." only to skip words inside it.
- point: 1-2 sentences addressed to the trainee ("You ..."), consistent with the excerpt.

Return an empty list if no passage supports a useful point.`;

	const baseInput = `${input.context ? `Case facts: ${input.context.safetyFacts}\nExaminer's key points:\n${input.context.keyPoints.map((k) => `- ${k}`).join("\n")}\n\n` : ""}TRAINEE's diagnosis and management: """${input.answer}"""
EXAMINER's follow-up question (not the trainee's words): """${input.followUpQuestion}"""
TRAINEE's reply: """${input.followUpAnswer}"""

${passages}`;

	const ask = async (extra = "") =>
		(
			await llm({
				name: "revision_point",
				schema: RevisionSchema,
				model: MODELS.revision,
				instructions,
				input: baseInput + extra,
			})
		).candidates;

	const verified = (c: Candidate) => {
		const h = hits.find((x) => x.chunk.id === c.chunk_id);
		return h && excerptIsVerbatim(c.excerpt, h.chunk) ? h : undefined;
	};
	/** Highest-priority candidate the trainee hasn't already covered. */
	const best = (cs: Candidate[]) =>
		cs
			// "Already covered" rules out corrections, not reinforcement, which by
			// definition is something the trainee said.
			.filter(
				(c) =>
					c.category === "reinforce_correct_point" ||
					!c.already_in_trainee_answer,
			)
			.sort((a, b) => PRIORITY[a.category] - PRIORITY[b.category])[0];

	let candidates = await ask();
	let chosen = best(candidates);

	// One retry when the chosen citation doesn't check out, telling the model why.
	// The guard itself is unchanged: an unverified excerpt is never shown.
	if (chosen && !verified(chosen)) {
		candidates = await ask(
			`\n\nYour excerpt "${chosen.excerpt}" does not appear word for word in passage ${chosen.chunk_id}. List the candidates again and copy every excerpt exactly from the passage it cites.`,
		);
		chosen = best(candidates);
	}

	if (!chosen)
		return {
			supported: false,
			reason: "no_support",
			message: NO_SUPPORT,
			retrieved,
		};

	const hit = hits.find((h) => h.chunk.id === chosen.chunk_id);
	if (!hit)
		return {
			supported: false,
			reason: "chunk_not_retrieved",
			message: NO_SUPPORT,
			retrieved,
		};

	// The guard: an excerpt that is not in the cited passage is a fabricated citation.
	if (!excerptIsVerbatim(chosen.excerpt, hit.chunk))
		return {
			supported: false,
			reason: "citation_not_verbatim",
			message: NO_SUPPORT,
			retrieved,
		};

	return {
		supported: true,
		category: chosen.category,
		point: chosen.point,
		page: hit.chunk.page,
		heading: chunkHeading(hit.chunk),
		chunkId: hit.chunk.id,
		excerpt: chosen.excerpt,
		retrieved,
	};
}
