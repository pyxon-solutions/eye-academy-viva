import { describe, expect, it } from "vitest";
import { catalogue, vivaCase } from "#/domain/case";
import { retriever } from "#/domain/reference";
import type { StructuredLLM } from "../llm";
import { type Deps, newAttempt, takeTurn } from "./engine";

/** Stub LLM: returns a canned object per structured-output name. */
const stub =
	(responses: Record<string, unknown>): StructuredLLM =>
	async ({ name }) => {
		if (!(name in responses)) throw new Error(`unexpected LLM call ${name}`);
		return responses[name] as never;
	};

const deps = (responses: Record<string, unknown>): Deps => ({
	llm: stub(responses),
	vivaCase,
	catalogue,
	retriever,
	now: () => 1,
});

describe("viva engine", () => {
	it("an available finding is read back from the case, not from the model", async () => {
		const { attempt, reply } = await takeTurn(
			newAttempt("alice", vivaCase, 0),
			"What's the pressure in the right eye?",
			deps({
				viva_intent: {
					kind: "findings",
					requests: [{ topic: "iop", eye: "right", asked: "pressure" }],
				},
			}),
		);
		expect(reply.text).toBe("Right eye · Intraocular pressure: 58 mmHg");
		expect(reply.speech).toBe(
			"Right eye: intraocular pressure, 58 millimetres of mercury.",
		);
		expect(attempt.revealed).toEqual(["iop_right"]);
		expect(attempt.transcript.map((t) => t.role)).toEqual([
			"examiner",
			"trainee",
			"examiner",
		]);
	});

	it("an unavailable finding says so and gives the case's reason", async () => {
		const { reply, attempt } = await takeTurn(
			newAttempt("alice", vivaCase, 0),
			"Can I see the right fundus?",
			deps({
				viva_intent: {
					kind: "findings",
					requests: [{ topic: "fundus", eye: "right", asked: "fundus" }],
				},
			}),
		);
		expect(reply.findings?.[0]).toMatchObject({
			kind: "unavailable",
			findingId: "fundus_right",
		});
		expect(reply.text).toContain(
			"not available (Poor view through oedematous cornea)",
		);
		expect(attempt.revealed).toEqual(["fundus_right"]);
	});

	it("answer → follow-up → revision point, and a fabricated excerpt is rejected", async () => {
		let a = newAttempt("alice", vivaCase, 0);
		({ attempt: a } = await takeTurn(
			a,
			"Acute angle closure. I'd give drops and laser the right eye.",
			deps({
				viva_intent: { kind: "answer", requests: [] },
				viva_follow_up: {
					responds_to: "laser right eye only",
					question: "Why treat the left eye as well?",
				},
			}),
		));
		expect(a.phase).toBe("follow_up");

		const fabricated = await takeTurn(
			a,
			"Because it is also narrow.",
			deps({
				revision_point: {
					supported: true,
					chunk_id: "p6-20",
					excerpt: "the other eye should always be lasered within 24 hours",
					point: "You should laser both eyes.",
				},
			}),
		);
		expect(fabricated.attempt.phase).toBe("completed");
		expect(fabricated.attempt.revision).toMatchObject({
			supported: false,
			reason: "citation_not_verbatim",
		});
	});
});
