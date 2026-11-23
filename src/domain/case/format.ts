import type { FindingResult } from "./catalogue";
import type { Finding } from "./schema";

const EYE_LABEL = { right: "Right eye", left: "Left eye", both: "Both eyes" };

export const eyeLabel = (f: Finding) => (f.eye ? EYE_LABEL[f.eye] : null);

/**
 * Display value: the case value verbatim, with the unit appended only when the
 * value does not already carry it ("58" + "mmHg", but not "5 mm" + "mm").
 */
export function displayValue(f: Finding): string | null {
	if (f.value === null) return null;
	const value = String(f.value);
	if (!f.unit || f.unit === "Snellen" || value.includes(f.unit)) return value;
	return `${value} ${f.unit}`;
}

/** Plain-text line for the transcript and on-screen card. */
export function displayLine(r: FindingResult): string {
	if (r.kind === "not_in_case") return `${r.asked}: not available in this case`;
	const eye = eyeLabel(r.finding);
	const head = eye ? `${eye} · ${r.finding.label}` : r.finding.label;
	if (r.kind === "unavailable") return `${head}: not available (${r.reason})`;
	return `${head}: ${displayValue(r.finding)}`;
}

/* ------------------------------------------------------------------ speech */

const ONES = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
];
const TENS = [
	"",
	"",
	"twenty",
	"thirty",
	"forty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety",
];

function small(n: number): string {
	if (n < 20) return ONES[n];
	const t = TENS[Math.floor(n / 10)];
	return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

/**
 * Rewrites clinical notation so a TTS engine reads it the way a clinician says it.
 * Only the *spoken* string is rewritten; the on-screen text stays verbatim.
 */
export function toSpeech(text: string): string {
	return (
		text
			// Snellen acuity: 6/36 → "six thirty-six" (never "six divided by thirty-six" or a date)
			.replace(
				/\b(3|6)\/(\d{1,2})\b/g,
				(_, a, b) => `${small(+a)} ${small(+b)}`,
			)
			// Blood pressure: 168/94 → "168 over 94"
			.replace(/\b(\d{2,3})\/(\d{2,3})\b/g, "$1 over $2")
			.replace(/\b1\/4\b/g, "one quarter")
			.replace(/\bmmHg\b/g, "millimetres of mercury")
			.replace(
				/([+-])(\d+(?:\.\d+)?) DS\b/g,
				(_, s, n) => `${s === "+" ? "plus" : "minus"} ${n} dioptres sphere`,
			)
			.replace(/(\d) mm\b/g, "$1 millimetres")
			.replace(/\bOCT\b/g, "O C T")
			.replace(/\bRAPD\b/g, "R A P D")
	);
}

export function speakResult(r: FindingResult): string {
	if (r.kind === "not_in_case")
		return `I'm afraid ${r.asked} isn't available in this case.`;
	const { eye, label } = r.finding;
	const prefix =
		eye === "right" || eye === "left" ? `${capitalise(eye)} eye: ` : "";
	const subject = prefix ? label.toLowerCase() : label;
	if (r.kind === "unavailable")
		return toSpeech(`${prefix}${subject} is not available. ${r.reason}.`);
	return toSpeech(`${prefix}${subject}, ${displayValue(r.finding)}.`);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const speakResults = (rs: FindingResult[]) =>
	rs.map(speakResult).join(" ");
