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
import { generateRevisionPoint } from "../src/server/viva/revision.ts";

try {
	process.loadEnvFile(".env");
} catch {}
if (!process.env.OPENAI_API_KEY) {
	console.error("OPENAI_API_KEY is not set (add it to .env).");
	process.exit(1);
}

const vivaCase = CaseSchema.parse(JSON.parse(readFileSync("data/source/case-EA-VIVA-001.json", "utf8")));
const catalogue = buildCatalogue(vivaCase);
const retriever = createRetriever(
	ReferenceIndexSchema.parse(JSON.parse(readFileSync("data/reference-index.json", "utf8"))),
);
const deps = { llm: openaiStructured, vivaCase, catalogue, retriever };

type Result = { name: string; input: string; expected: string; observed: string; pass: boolean };
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
		pass: reply.text === expected && (reply.speech ?? "").includes("58 millimetres of mercury"),
	});
}

// 2. Unavailable finding -------------------------------------------------------
{
	const input = "Can I see the right fundus?";
	const { reply } = await takeTurn(newAttempt("checks", vivaCase), input, deps);
	const f = vivaCase.findings.find((x) => x.id === "fundus_right");
	const expected = f ? displayLine({ kind: "unavailable", finding: f, reason: f.unavailable_reason ?? "" }) : "";
	results.push({
		name: "2. Unavailable finding",
		input,
		expected: `${expected} (no value invented)`,
		observed: `${reply.text} | kind: ${reply.findings?.map((x) => x.kind).join(", ")}`,
		pass: reply.text === expected && reply.findings?.[0]?.kind === "unavailable",
	});
}

// 3. Citation supports the revision point -------------------------------------
{
	const input = {
		answer:
			"Right acute angle closure. I'd give topical timolol and apraclonidine, IV acetazolamide, then laser iridotomy to the right eye.",
		followUpQuestion: "Why would you consider laser iridotomy on the left eye as well?",
		followUpAnswer: "I don't know.",
	};
	const rev = await generateRevisionPoint(openaiStructured, retriever, input);
	const retrieved = rev.retrieved.map((r) => `p${r.page} ${r.heading}`).join("; ");
	results.push({
		name: "3. Citation supports the revision point",
		input: `answer: "${input.answer}" / follow-up: "${input.followUpQuestion}" / reply: "${input.followUpAnswer}"`,
		expected:
			"Supported; cites p6 'Managing an acute attack › Definitive treatment' (fellow-eye LPI); excerpt appears verbatim in that passage",
		observed: rev.supported
			? `Supported; cites p${rev.page} '${rev.heading}'; excerpt: "${rev.excerpt}"; verbatim check passed | point: ${rev.point} | retrieved: ${retrieved}`
			: `Not supported (${rev.reason}) | retrieved: ${retrieved}`,
		pass: rev.supported && rev.page === 6 && rev.heading.endsWith("Definitive treatment"),
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
