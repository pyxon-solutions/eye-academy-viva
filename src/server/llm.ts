import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

/**
 * Model choices, in one place so the write-up and the code agree.
 * - reasoning: intent parsing, the follow-up question and the revision point.
 *   gpt-4.1-mini: strict structured output, low latency, cheap enough for a demo.
 * - transcribe: speech-to-text for the trainee's turn.
 * - revision: the end-of-viva revision point. gpt-4.1: it has to judge which gap
 *   in the answer matters most (labelling candidates reliably); mini mislabelled
 *   the safety issue. Runs once per viva, so the extra latency and cost are small.
 * - tts: the examiner's voice; steerable tone via `instructions`, streams MP3.
 */
export const MODELS = {
	reasoning: "gpt-4.1-mini",
	revision: "gpt-4.1",
	transcribe: "gpt-4o-transcribe",
	tts: "gpt-4o-mini-tts",
} as const;

let client: OpenAI | undefined;
export const openai = () => {
	client ??= new OpenAI(); // reads OPENAI_API_KEY
	return client;
};

/** A structured-output call. Injected into the viva logic so tests can stub it. */
export type StructuredLLM = <S extends z.ZodType>(args: {
	name: string;
	schema: S;
	instructions: string;
	input: string;
	/** Defaults to MODELS.reasoning. */
	model?: string;
}) => Promise<z.infer<S>>;

export const openaiStructured: StructuredLLM = async ({
	name,
	schema,
	instructions,
	input,
	model = MODELS.reasoning,
}) => {
	const res = await openai().responses.parse({
		model,
		instructions,
		input,
		temperature: 0.2,
		text: { format: zodTextFormat(schema, name) },
	});
	if (!res.output_parsed) throw new Error(`No structured output for ${name}`);
	return res.output_parsed as z.infer<typeof schema>;
};

export async function transcribe(audio: File): Promise<string> {
	const res = await openai().audio.transcriptions.create({
		model: MODELS.transcribe,
		file: audio,
		language: "en",
		// Biases the decoder towards the vocabulary trainees actually use.
		prompt:
			"Ophthalmology viva. Terms: intraocular pressure, IOP, gonioscopy, Van Herick, RAPD, fundus, cup-to-disc, OCT, axial length, acetazolamide, pilocarpine, iridotomy, LPI.",
	});
	return res.text.trim();
}
