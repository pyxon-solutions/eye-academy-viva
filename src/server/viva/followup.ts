import { z } from "zod";
import type { VivaCase } from "#/domain/case";
import type { StructuredLLM } from "../llm";

const FollowUpSchema = z.object({
	/** Which part of the trainee's answer the question picks up on, for the transcript/debugging. */
	responds_to: z.string(),
	question: z.string(),
});

/** The case facts a safe plan has to account for (allergies, current drugs). */
export const safetyFacts = (c: VivaCase) =>
	`Allergies: ${c.patient.allergies}. Current medications: ${c.patient.medications.join("; ")}.`;

/**
 * One spoken follow-up that responds to what the trainee actually said.
 * Patient safety comes first (e.g. a drug this patient is allergic to, or a
 * precipitating drug left running); otherwise it probes a gap or a claim,
 * steered by the case's follow-up ideas.
 */
export async function generateFollowUp(
	llm: StructuredLLM,
	vivaCase: VivaCase,
	traineeAnswer: string,
): Promise<z.infer<typeof FollowUpSchema>> {
	const notes = vivaCase.examiner_notes;
	return llm({
		name: "viva_follow_up",
		schema: FollowUpSchema,
		instructions: `You are a calm consultant ophthalmologist examining a trainee in a practice viva.
The trainee has just given their diagnosis and management. Ask exactly ONE follow-up question.

Choose what to ask, in this order:
1. Patient safety. If their plan could harm THIS patient given the case facts below (a drug she is allergic to, or one that needs a check they did not mention), or leaves a precipitating drug running, ask about that. Something they already handled correctly (e.g. they said to stop a drug) is not a safety gap.
2. Otherwise, a key point they missed or a claim they made. Prefer one of the follow-up ideas if it fits; adapt the wording to their answer.

Rules:
- It must respond to something specific in what they said (or clearly left out).
- One sentence, under 30 words, natural to say aloud. No feedback, no praise, no hints, do not reveal the diagnosis.
- Do not mention pages or the reference note.

Case: ${vivaCase.title}
Case facts: ${safetyFacts(vivaCase)}
Examiner's diagnosis: ${notes.diagnosis}
Key points:
${notes.key_points.map((k) => `- ${k}`).join("\n")}
Follow-up ideas:
${notes.follow_up_ideas.map((k) => `- ${k}`).join("\n")}`,
		input: `Trainee's answer: """${traineeAnswer}"""`,
	});
}
