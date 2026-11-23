import { z } from "zod";
import {
	chunkHeading,
	excerptIsVerbatim,
	type Retriever,
} from "#/domain/reference";
import type { StructuredLLM } from "../llm";

export type RevisionInput = {
	answer: string;
	followUpQuestion: string;
	followUpAnswer: string;
};

/** Everything the check write-up needs: what was retrieved, what was cited, and whether it held up. */
export type RevisionResult =
	| {
			supported: true;
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

const RevisionSchema = z.object({
	supported: z.boolean(),
	chunk_id: z.string().nullable(),
	excerpt: z.string(),
	point: z.string(),
});

const NO_SUPPORT =
	"I couldn't find a passage in the reference note that supports a revision point on your answer, so I won't make one up.";

export const K = 5;

/**
 * Retrieval queries, fused by rank: the follow-up exchange (short and specific,
 * where the point usually lands) and the trainee's main answer.
 */
export const retrievalQueries = (i: RevisionInput) => [
	`${i.followUpQuestion} ${i.followUpAnswer}`,
	i.answer,
];

export async function generateRevisionPoint(
	llm: StructuredLLM,
	retriever: Retriever,
	input: RevisionInput,
): Promise<RevisionResult> {
	const hits = retriever.searchMany(retrievalQueries(input), K);
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

	const out = await llm({
		name: "revision_point",
		schema: RevisionSchema,
		instructions: `You write ONE revision point for an ophthalmology trainee after a practice viva.
Use ONLY the passages provided. The point must address something in the trainee's answers:
correct a mistake, fill an important gap, or reinforce a key fact they reached for.

Return:
- supported: false if none of the passages supports a useful point about their answer. Do not use outside knowledge.
- chunk_id: the id of the single passage that supports the point (null if unsupported).
- excerpt: a short quotation copied EXACTLY, character for character, from that passage (one sentence or clause, max 35 words). Use "..." only to skip words inside it.
- point: the revision point, 1-2 sentences, addressed to the trainee ("You ..."), consistent with the excerpt.`,
		input: `Trainee's diagnosis and management: """${input.answer}"""
Examiner's follow-up: """${input.followUpQuestion}"""
Trainee's reply: """${input.followUpAnswer}"""

${passages}`,
	});

	if (!out.supported || !out.chunk_id)
		return {
			supported: false,
			reason: "no_support",
			message: NO_SUPPORT,
			retrieved,
		};

	const hit = hits.find((h) => h.chunk.id === out.chunk_id);
	if (!hit)
		return {
			supported: false,
			reason: "chunk_not_retrieved",
			message: NO_SUPPORT,
			retrieved,
		};

	// The guard: an excerpt that is not in the cited passage is a fabricated citation.
	if (!excerptIsVerbatim(out.excerpt, hit.chunk))
		return {
			supported: false,
			reason: "citation_not_verbatim",
			message: NO_SUPPORT,
			retrieved,
		};

	return {
		supported: true,
		point: out.point,
		page: hit.chunk.page,
		heading: chunkHeading(hit.chunk),
		chunkId: hit.chunk.id,
		excerpt: out.excerpt,
		retrieved,
	};
}
