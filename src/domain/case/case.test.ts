import { describe, expect, it } from "vitest";
import {
	catalogue,
	displayLine,
	displayValue,
	resolveRequest,
	speakResult,
	toSpeech,
	vivaCase,
} from "./index";

const ask = (
	topic: string | null,
	eye: "right" | "left" | "both" | "unspecified" = "unspecified",
	asked = topic ?? "",
) => resolveRequest(catalogue, { topic, eye, asked });

describe("available findings are returned verbatim with eye, value and unit", () => {
	it("right IOP → 58 mmHg, right eye only", () => {
		const [r, ...rest] = ask("iop", "right");
		expect(rest).toHaveLength(0);
		expect(r.kind).toBe("available");
		if (r.kind !== "available") return;
		expect(r.finding.id).toBe("iop_right");
		expect(displayLine(r)).toBe("Right eye · Intraocular pressure: 58 mmHg");
		expect(speakResult(r)).toBe(
			"Right eye: intraocular pressure, 58 millimetres of mercury.",
		);
	});

	it("no eye specified → both eyes, right first, as an examiner would answer", () => {
		const rs = ask("va");
		expect(rs.map((r) => r.kind === "available" && r.finding.id)).toEqual([
			"va_right",
			"va_left",
		]);
	});

	it("does not append a unit the value already carries", () => {
		const [r] = ask("pupil", "right");
		expect(r.kind === "available" && displayValue(r.finding)).toBe(
			"Mid-dilated, 5 mm, unreactive to light",
		);
	});

	it("history is answerable through the same verbatim path", () => {
		const [r] = ask("history_allergies");
		expect(displayLine(r)).toBe("Allergies: Sulfonamide antibiotics (rash)");
	});

	it("every available case value appears verbatim on screen", () => {
		for (const f of vivaCase.findings.filter((f) => f.available)) {
			const line = displayLine({ kind: "available", finding: f });
			expect(line, f.id).toContain(String(f.value));
			if (f.unit && f.unit !== "Snellen") expect(line, f.id).toContain(f.unit);
		}
	});
});

describe("unavailable findings say so and never invent a value", () => {
	it("right gonioscopy → unavailable with the case's reason", () => {
		const [r] = ask("gonio", "right");
		expect(r.kind).toBe("unavailable");
		expect(displayLine(r)).toBe(
			"Right eye · Gonioscopy: not available (No view: corneal oedema)",
		);
		expect(speakResult(r)).toContain("not available");
	});

	it("left gonioscopy is still available when the right is not", () => {
		const [r] = ask("gonio", "left");
		expect(r.kind).toBe("available");
	});

	it("something the case does not contain → not_in_case", () => {
		const [r] = ask(null, "unspecified", "visual fields");
		expect(r).toEqual({ kind: "not_in_case", asked: "visual fields" });
		expect(speakResult(r)).toBe(
			"I'm afraid visual fields isn't available in this case.",
		);
	});

	it("an unknown topic key from the model is treated as not in case", () => {
		const [r] = ask("made_up_topic", "right", "corneal topography");
		expect(r.kind).toBe("not_in_case");
	});
});

describe("speech normalisation", () => {
	it.each([
		["6/36", "six thirty-six"],
		["6/9", "six nine"],
		["168/94 mmHg", "168 over 94 millimetres of mercury"],
		["Right +3.50 DS, left +3.25 DS", "Right plus 3.50 dioptres sphere, left plus 3.25 dioptres sphere"],
		["under 1/4 of corneal thickness", "under one quarter of corneal thickness"],
	])("%s → %s", (input, spoken) => {
		expect(toSpeech(input)).toBe(spoken);
	});
});
