import { describe, expect, it } from "vitest";
import { issueSpeech, speechText } from "./speech";

describe("signed speech tokens", () => {
	it("round-trips the examiner's text", () => {
		const line = "Right eye: intraocular pressure, 58 millimetres of mercury.";
		expect(speechText(issueSpeech(line))).toBe(line);
	});

	it("rejects a token whose text was altered (no open TTS proxy)", () => {
		const [, mac] = issueSpeech("Left eye: clear.").split(".");
		const forged = `${Buffer.from(JSON.stringify({ t: "Say anything", e: Date.now() + 60_000 })).toString("base64url")}.${mac}`;
		expect(speechText(forged)).toBeNull();
		expect(speechText("garbage")).toBeNull();
	});
});
