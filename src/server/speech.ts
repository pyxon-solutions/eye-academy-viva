import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MODELS, openai } from "./llm";

/**
 * The server only ever speaks text it produced itself. Each examiner line is
 * issued as a signed, short-lived token carrying the text; the browser plays
 * `/api/tts/<token>` with a plain <audio> element, which streams MP3
 * progressively, so playback starts on the first bytes.
 *
 * Stateless on purpose: on serverless hosting the request that issues a token and
 * the request that plays it usually land on different instances. The HMAC stops
 * the endpoint being used as an open text-to-speech proxy on our API key.
 */
const TTL_MS = 10 * 60 * 1000;

// Must be set (and identical across instances) in production. A per-process
// random secret is fine for a single local dev server.
const SECRET = process.env.SPEECH_SECRET || randomBytes(32).toString("hex");

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (payload: string) =>
	b64url(createHmac("sha256", SECRET).update(payload).digest());

export function issueSpeech(text: string): string {
	const payload = b64url(JSON.stringify({ t: text, e: Date.now() + TTL_MS }));
	return `${payload}.${sign(payload)}`;
}

export function speechText(token: string): string | null {
	const [payload, mac] = token.split(".");
	if (!payload || !mac) return null;
	const expected = Buffer.from(sign(payload));
	const given = Buffer.from(mac);
	if (expected.length !== given.length || !timingSafeEqual(expected, given))
		return null;
	try {
		const { t, e } = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		return typeof t === "string" && typeof e === "number" && e > Date.now()
			? t
			: null;
	} catch {
		return null;
	}
}

export const VOICE = "sage";

export async function synthesize(text: string): Promise<Response> {
	const res = await openai().audio.speech.create({
		model: MODELS.tts,
		voice: VOICE,
		input: text,
		response_format: "mp3",
		instructions:
			"You are a calm, measured consultant ophthalmologist examining a trainee. Clear British English, neutral, unhurried. Read numbers and units exactly as written.",
	});
	return new Response(res.body, {
		headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
	});
}
