import { z } from "zod";
import type { FindingRequest, Topic } from "#/domain/case";
import type { StructuredLLM } from "../llm";

/**
 * What the trainee just said, as far as the examiner is concerned:
 *  - findings: they asked for one or more examination/history findings
 *  - answer:   they gave a diagnosis and/or management plan
 *  - other:    anything else (small talk, "can you repeat that?")
 *
 * The model only picks topic keys from a closed enum built from the case, so it
 * cannot introduce a value; values are resolved deterministically afterwards.
 */
export function intentSchema(catalogue: Topic[]) {
	const keys = catalogue.map((t) => t.key) as [string, ...string[]];
	return z.object({
		kind: z.enum(["findings", "answer", "other"]),
		requests: z.array(
			z.object({
				topic: z.enum(keys).nullable(),
				eye: z.enum(["right", "left", "both", "unspecified"]),
				asked: z.string(),
			}),
		),
	});
}
export type Intent = {
	kind: "findings" | "answer" | "other";
	requests: FindingRequest[];
};

export function intentInstructions(catalogue: Topic[]) {
	const topics = catalogue.map((t) => `- ${t.key}: ${t.label}`).join("\n");
	return `You route what an ophthalmology trainee says during a practice viva.

Classify the utterance:
- "findings": they ask for one or more findings (examination, history, investigations).
- "answer": they state a diagnosis and/or management plan (even if they also ask something).
- "other": anything else.

For "findings", add one request per thing asked for:
- topic: the key from the list below that answers it, or null if nothing in the list does.
- eye: "right"/"left" if they named one eye, "both" if they said both, otherwise "unspecified".
  History and whole-patient items (blood pressure, RAPD, refraction) use "unspecified".
- asked: their own words for it, short (e.g. "visual fields").
Map common synonyms: "pressures"/"IOP" → iop, "vision"/"acuity" → va, "angles" → gonio,
"disc"/"optic nerve"/"back of the eye" → fundus, "AC" → ac, "drugs"/"meds" → history_medications,
"PMH" → history_past_medical_history.
Be strict: map only when the topic answers exactly what was asked. A similar-sounding test is a
different test: "visual fields"/"perimetry"/"confrontation" are NOT visual acuity; "corneal thickness"/
"pachymetry" is NOT cornea; "colour vision" is NOT acuity; "blood glucose" is NOT u_and_e.
Never invent a topic key; if a request is not covered, use null. For "answer"/"other", requests is [].

Examples:
"What are the visual fields?" → findings [{topic: null, eye: "unspecified", asked: "visual fields"}]
"Pachymetry please" → findings [{topic: null, eye: "unspecified", asked: "pachymetry"}]
"How's the right cornea?" → findings [{topic: "cornea", eye: "right", asked: "cornea"}]
"What's her vision in the left eye?" → findings [{topic: "va", eye: "left", asked: "vision"}]

Topics in this case:
${topics}`;
}

export async function parseIntent(
	llm: StructuredLLM,
	catalogue: Topic[],
	utterance: string,
): Promise<Intent> {
	const out = await llm({
		name: "viva_intent",
		schema: intentSchema(catalogue),
		instructions: intentInstructions(catalogue),
		input: utterance,
	});
	return out as Intent;
}
