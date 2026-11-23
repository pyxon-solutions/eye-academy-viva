import type { Eye, Finding, VivaCase } from "./schema";

/**
 * The trainee asks for *topics* ("pressures", "the left disc"); the case stores
 * per-eye *findings* (`iop_right`, `iop_left`). A topic groups the findings that
 * answer the same question, so "what are the pressures?" can return both eyes.
 *
 * History items are exposed as eye-less findings so they flow through exactly the
 * same verbatim path as examination findings.
 */
export type Topic = {
	key: string;
	label: string;
	findings: Finding[];
};

const EYE_SUFFIX = /_(right|left)$/;

export const topicKeyOf = (findingId: string) =>
	findingId.replace(EYE_SUFFIX, "");

export function historyFindings(c: VivaCase): Finding[] {
	const p = c.patient;
	const item = (id: string, label: string, value: string): Finding => ({
		id: `history_${id}`,
		eye: null,
		label,
		value,
		unit: null,
		method: "History",
		available: true,
	});
	return [
		item("presenting_complaint", "Presenting complaint", p.presenting_complaint),
		item("past_ocular_history", "Past ocular history", p.past_ocular_history),
		item("past_medical_history", "Past medical history", p.past_medical_history),
		item("medications", "Medications", p.medications.join("; ")),
		item("allergies", "Allergies", p.allergies),
		item("family_history", "Family history", p.family_history),
	];
}

export function buildCatalogue(c: VivaCase): Topic[] {
	const topics = new Map<string, Topic>();
	for (const f of [...c.findings, ...historyFindings(c)]) {
		const key = topicKeyOf(f.id);
		const topic = topics.get(key) ?? { key, label: f.label, findings: [] };
		topic.findings.push(f);
		topics.set(key, topic);
	}
	return [...topics.values()];
}

export type FindingRequest = {
	/** A topic key from the catalogue, or null when the trainee asked for something the case does not contain. */
	topic: string | null;
	eye: "right" | "left" | "both" | "unspecified";
	/** What the trainee called it, used when the topic is not in the case. */
	asked: string;
};

export type FindingResult =
	| { kind: "available"; finding: Finding }
	| { kind: "unavailable"; finding: Finding; reason: string }
	| { kind: "not_in_case"; asked: string };

const matchesEye = (f: Finding, eye: Eye) =>
	f.eye === eye || f.eye === "both" || f.eye === null;

/**
 * Deterministic lookup. The model only decides *which* topic and eye were asked
 * for; every value spoken or shown comes from the case file through here.
 */
export function resolveRequest(
	catalogue: Topic[],
	req: FindingRequest,
): FindingResult[] {
	const topic = req.topic
		? catalogue.find((t) => t.key === req.topic)
		: undefined;
	if (!topic) return [{ kind: "not_in_case", asked: req.asked }];

	const selected =
		req.eye === "right" || req.eye === "left"
			? topic.findings.filter((f) => matchesEye(f, req.eye as Eye))
			: topic.findings; // "both" or unspecified: give every eye, as an examiner would

	const findings = selected.length > 0 ? selected : topic.findings;
	return findings.map((finding) =>
		finding.available
			? { kind: "available", finding }
			: {
					kind: "unavailable",
					finding,
					reason: finding.unavailable_reason ?? "Not available",
				},
	);
}
