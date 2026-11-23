import { z } from "zod";
import type { VivaCase } from "#/domain/case";
import type { StructuredLLM } from "../llm";

const FollowUpSchema = z.object({
	/** Which part of the trainee's answer the question picks up on, for the transcript/debugging. */
	responds_to: z.string(),
	question: z.string(),
});

/**
 * One spoken follow-up that responds to what the trainee actually said:
 * probe a gap or a claim in their answer, steered by the case's follow-up ideas.
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

Rules:
- It must respond to something specific in what they said: probe a claim they made, or a key point they missed.
- Prefer one of the follow-up ideas if it fits what they said; adapt the wording to their answer.
- One sentence, under 30 words, natural to say aloud. No feedback, no praise, no hints, do not reveal the diagnosis.
- Do not mention pages or the reference note.

Case: ${vivaCase.title}
Examiner's diagnosis: ${notes.diagnosis}
Key points:
${notes.key_points.map((k) => `- ${k}`).join("\n")}
Follow-up ideas:
${notes.follow_up_ideas.map((k) => `- ${k}`).join("\n")}`,
		input: `Trainee's answer: """${traineeAnswer}"""`,
	});
}
