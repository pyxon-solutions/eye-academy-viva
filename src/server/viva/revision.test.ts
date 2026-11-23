import { describe, expect, it } from "vitest";
import { retriever } from "#/domain/reference";
import type { StructuredLLM } from "../llm";
import { generateRevisionPoint, type RevisionInput } from "./revision";

/** Answers each call with the next canned candidate list. */
const sequence = (...lists: unknown[][]): StructuredLLM => {
	let i = 0;
	return async () =>
		({ candidates: lists[Math.min(i++, lists.length - 1)] }) as never;
};

const input: RevisionInput = {
	answer:
		"Right acute angle closure. Topical timolol and apraclonidine, IV acetazolamide, then laser iridotomy to the right eye.",
	followUpQuestion:
		"Why would you consider laser iridotomy on the left eye as well?",
	followUpAnswer: "I don't know.",
	context: {
		safetyFacts: "Allergies: Sulfonamide antibiotics (rash).",
		allergies: "Sulfonamide antibiotics (rash)",
		medications: "Amlodipine, Chlorphenamine",
		keyPoints: [],
	},
};

// Verbatim sentences from passages this input retrieves.
const allergy = {
	category: "unsafe_drug_for_this_patient",
	already_in_trainee_answer: false,
	chunk_id: "p6-18",
	excerpt:
		"Check for sulfonamide allergy, kidney disease, low potassium and sickle cell disease before giving it.",
	point: "You gave acetazolamide without checking her sulfonamide allergy.",
};
const trigger = {
	category: "precipitating_drug_left_running",
	already_in_trainee_answer: false,
	chunk_id: "p4-13",
	excerpt:
		"Drugs with anticholinergic effects, including some antihistamines (for example chlorphenamine)",
	point: "You should stop the chlorphenamine.",
};
const fellowEye = {
	category: "missed_key_point",
	already_in_trainee_answer: false,
	chunk_id: "p6-20",
	excerpt: "Prophylactic LPI in the fellow eye",
	point: "You should offer LPI to the fellow eye.",
};

describe("revision point priority is decided in code, not by the model", () => {
	it("the safety retrieval brings in the allergy and trigger passages", async () => {
		const rev = await generateRevisionPoint(sequence([]), retriever, input);
		const ids = rev.retrieved.map((r) => r.chunkId);
		expect(ids).toEqual(expect.arrayContaining(["p6-18", "p4-13", "p6-20"]));
	});

	it("an unsafe drug for this patient beats a trigger left running and a missed point, in any order", async () => {
		const rev = await generateRevisionPoint(
			sequence([fellowEye, trigger, allergy]),
			retriever,
			input,
		);
		expect(rev).toMatchObject({
			supported: true,
			category: "unsafe_drug_for_this_patient",
			page: 6,
		});
	});

	it("drops what the trainee already covered", async () => {
		const rev = await generateRevisionPoint(
			sequence([{ ...trigger, already_in_trainee_answer: true }, fellowEye]),
			retriever,
			input,
		);
		expect(rev).toMatchObject({
			supported: true,
			category: "missed_key_point",
		});
	});

	it("retries once when the chosen excerpt isn't verbatim, then uses the corrected one", async () => {
		const rev = await generateRevisionPoint(
			sequence(
				[
					{
						...allergy,
						excerpt: "Always avoid acetazolamide in sulfonamide allergy.",
					},
				],
				[allergy],
			),
			retriever,
			input,
		);
		expect(rev).toMatchObject({
			supported: true,
			category: "unsafe_drug_for_this_patient",
		});
	});

	it("still refuses when the retry is not verbatim either", async () => {
		const fake = { ...allergy, excerpt: "Never give acetazolamide." };
		const rev = await generateRevisionPoint(
			sequence([fake], [fake]),
			retriever,
			input,
		);
		expect(rev).toMatchObject({
			supported: false,
			reason: "citation_not_verbatim",
		});
	});

	it("a complete answer still gets a point: reinforcement survives the 'already covered' filter", async () => {
		const reinforce = {
			...fellowEye,
			category: "reinforce_correct_point",
			already_in_trainee_answer: true,
			point: "You rightly planned LPI for the fellow eye.",
		};
		const rev = await generateRevisionPoint(
			sequence([{ ...trigger, already_in_trainee_answer: true }, reinforce]),
			retriever,
			input,
		);
		expect(rev).toMatchObject({
			supported: true,
			category: "reinforce_correct_point",
		});
	});
});
