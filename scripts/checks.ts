/**
 * The three repeatable checks from the brief, run through the real pipeline
 * (OpenAI intent parsing, deterministic case lookup, BM25 retrieval, the
 * revision-point model and the verbatim-citation guard).
 *
 *   pnpm checks
 *
 * Needs OPENAI_API_KEY in .env. No Firebase: checks exercise the viva engine
 * directly, so they are independent of auth and storage.
 */
import { readFileSync } from "node:fs";
import { buildCatalogue } from "../src/domain/case/catalogue.ts";
import { displayLine } from "../src/domain/case/format.ts";
import { CaseSchema } from "../src/domain/case/schema.ts";
import { createRetriever } from "../src/domain/reference/retrieve.ts";
import { ReferenceIndexSchema } from "../src/domain/reference/schema.ts";
import { openaiStructured } from "../src/server/llm.ts";
import { newAttempt, takeTurn } from "../src/server/viva/engine.ts";

try {
	process.loadEnvFile(".env");
} catch {}
if (!process.env.OPENAI_API_KEY) {
	console.error("OPENAI_API_KEY is not set (add it to .env).");
	process.exit(1);
}

const vivaCase = CaseSchema.parse(
	JSON.parse(readFileSync("data/source/case-EA-VIVA-001.json", "utf8")),
);
const catalogue = buildCatalogue(vivaCase);
const retriever = createRetriever(
	ReferenceIndexSchema.parse(
		JSON.parse(readFileSync("data/reference-index.json", "utf8")),
	),
);
const deps = { llm: openaiStructured, vivaCase, catalogue, retriever };

const describeRetrieved = (r: unknown) =>
	Array.isArray(r)
		? r
				.map(
					(x: { page: number; heading: string }) => `p${x.page} ${x.heading}`,
				)
				.join("; ")
		: "";

type Result = {
	name: string;
	input: string;
	expected: string;
	observed: string;
	pass: boolean;
};
const results: Result[] = [];

// 1. Available finding ---------------------------------------------------------
{
	const input = "What's the pressure in the right eye?";
	const { reply } = await takeTurn(newAttempt("checks", vivaCase), input, deps);
	const expected = "Right eye · Intraocular pressure: 58 mmHg";
	results.push({
		name: "1. Available finding",
		input,
		expected: `${expected} (right eye only; spoken "58 millimetres of mercury")`,
		observed: `${reply.text} | spoken: "${reply.speech}"`,
		pass:
			reply.text === expected &&
			(reply.speech ?? "").includes("58 millimetres of mercury"),
	});
}

// 2. Unavailable finding -------------------------------------------------------
{
	const input = "Can I see the right fundus?";
	const { reply } = await takeTurn(newAttempt("checks", vivaCase), input, deps);
	const f = vivaCase.findings.find((x) => x.id === "fundus_right");
	const expected = f
		? displayLine({
				kind: "unavailable",
				finding: f,
				reason: f.unavailable_reason ?? "",
			})
		: "";
	results.push({
		name: "2. Unavailable finding",
		input,
		expected: `${expected} (no value invented)`,
		observed: `${reply.text} | kind: ${reply.findings?.map((x) => x.kind).join(", ")}`,
		pass:
			reply.text === expected && reply.findings?.[0]?.kind === "unavailable",
	});
}

// 3. Citation supports the revision point -------------------------------------
// Through the engine, exactly as the app runs it. The only gap in this answer is
// the fellow eye, so the point must come from the fellow-eye LPI passage.
{
	const answer =
		"Right acute angle closure. Topical timolol, apraclonidine and pilocarpine, analgesia and an antiemetic, stop the chlorphenamine, then laser iridotomy to the right eye.";
	const followUpQuestion =
		"Why would you consider laser iridotomy on the left eye as well?";
	const followUpAnswer = "I don't know.";
	const attempt = {
		...newAttempt("checks", vivaCase),
		phase: "follow_up" as const,
		answer,
		followUp: { question: followUpQuestion, respondsTo: "", answer: null },
	};
	const { attempt: done } = await takeTurn(attempt, followUpAnswer, deps);
	const rev = done.revision;
	const retrieved = describeRetrieved(rev?.retrieved);
	results.push({
		name: "3. Citation supports the revision point",
		input: `answer: "${answer}" / follow-up: "${followUpQuestion}" / reply: "${followUpAnswer}"`,
		expected:
			"Supported; cites p6 'Managing an acute attack › Definitive treatment' (fellow-eye LPI); excerpt appears verbatim in that passage",
		observed: rev?.supported
			? `Supported; chosen as ${"category" in rev ? rev.category : "?"}; cites p${rev.page} '${rev.heading}'; excerpt: "${rev.excerpt}"; verbatim check passed | point: ${rev.point} | retrieved: ${retrieved}`
			: `Not supported (${rev && "reason" in rev ? rev.reason : "none"}) | retrieved: ${retrieved}`,
		pass:
			!!rev?.supported &&
			rev.page === 6 &&
			rev.heading.endsWith("Definitive treatment"),
	});
}

// 4. Safety first: the most important gap wins --------------------------------
// The plan gives acetazolamide to a patient with a sulfonamide allergy and never
// mentions it. Both the follow-up and the revision point should go there, not to
// the fellow eye.
{
	const answer =
		"Right acute angle closure. Topical timolol and apraclonidine, IV acetazolamide, then laser iridotomy to the right eye.";
	const { attempt: asked, reply } = await takeTurn(
		newAttempt("checks", vivaCase),
		answer,
		deps,
	);
	// A plausible but incomplete reply: it must not count as covering the allergy.
	const followUpAnswer = "I'd check her kidney function.";
	const { attempt: done } = await takeTurn(asked, followUpAnswer, deps);
	const rev = done.revision;
	const safety = /allerg|sulfonamide|sulpha/i;
	// The follow-up must point at the decision without giving the answer away.
	const followUpOnSafety =
		/acetazolamide/i.test(reply.text) && !safety.test(reply.text);
	const pointOnSafety =
		!!rev?.supported &&
		safety.test(`${rev.point} ${rev.excerpt}`) &&
		/sulfonamide/i.test(rev.excerpt);
	results.push({
		name: "4. Safety first: sulfonamide allergy before acetazolamide",
		input: `answer: "${answer}" / follow-up: (generated) / reply: "${followUpAnswer}"`,
		expected:
			"Follow-up asks about acetazolamide WITHOUT naming the allergy (no hints); revision point is about the sulfonamide allergy, citing a passage whose excerpt mentions it (p6 'Immediate treatment', or the p9 medicines table)",
		observed: `follow-up: "${reply.text}" | ${
			rev?.supported
				? `chosen as ${"category" in rev ? rev.category : "?"}; cites p${rev.page} '${rev.heading}'; excerpt: "${rev.excerpt}"; point: ${rev.point}`
				: "not supported"
		} | retrieved: ${describeRetrieved(rev?.retrieved)}`,
		pass: followUpOnSafety && pointOnSafety,
	});
}

// 5. A complete answer is not over-corrected -----------------------------------
// Everything in the examiner's key points, including avoiding acetazolamide and
// stopping the chlorphenamine. There must be no invented safety issue, and there
// must still be a supported point (reinforcement, or a genuinely missed detail).
{
	const answer =
		"Right acute primary angle closure, with a narrow left angle at risk, probably triggered by the dark cinema and the new chlorphenamine. Stop the chlorphenamine. Lower the pressure with topical timolol and apraclonidine, then pilocarpine once the pressure starts to fall. I would avoid acetazolamide because of her sulfonamide allergy and use IV mannitol if needed. Give analgesia and an antiemetic. Laser peripheral iridotomy to both eyes once the cornea clears, then repeat gonioscopy of the right eye and examine both discs after the attack settles.";
	const { attempt: asked, reply } = await takeTurn(
		newAttempt("checks", vivaCase),
		answer,
		deps,
	);
	const { attempt: done } = await takeTurn(
		asked,
		"Because the left angle is also narrow, so it is at risk of an attack too.",
		deps,
	);
	const rev = done.revision;
	const category = rev && "category" in rev ? rev.category : undefined;
	const safetyCategories = [
		"unsafe_drug_for_this_patient",
		"precipitating_drug_left_running",
	];
	results.push({
		name: "5. A complete answer is not over-corrected",
		input: `answer covering every key point (stops chlorphenamine, avoids acetazolamide for the allergy, LPI both eyes…) / follow-up: (generated) / reply about the fellow eye`,
		expected:
			"Supported point that is NOT a safety correction (reinforcement, or a genuinely missed detail)",
		observed: `follow-up: "${reply.text}" | ${
			rev?.supported
				? `chosen as ${category}; cites p${rev.page} '${rev.heading}'; point: ${rev.point}`
				: "not supported"
		}`,
		pass:
			!!rev?.supported && !!category && !safetyCategories.includes(category),
	});
}

for (const r of results) {
	console.log(`\n${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
	console.log(`  input:    ${r.input}`);
	console.log(`  expected: ${r.expected}`);
	console.log(`  observed: ${r.observed}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
