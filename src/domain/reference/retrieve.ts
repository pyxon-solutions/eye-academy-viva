import MiniSearch from "minisearch";
import {
	chunkHeading,
	chunkText,
	type ReferenceChunk,
	type ReferenceIndex,
} from "./schema";

export type Retrieved = {
	chunk: ReferenceChunk;
	score: number;
};

/**
 * BM25 over ~34 page-scoped chunks. At this corpus size lexical retrieval is
 * deterministic, explainable in a walkthrough and needs no embedding calls.
 * Headings are boosted so "Managing an acute attack" outranks a passing mention.
 */
const STOPWORDS = new Set(
	`a an and are as at be because but by can could do does for from had has have how i i'd i'll i'm if in into is it its i've me my of on or so than that the their them then there these they this to too us was we what when where which while who why will with would you your also well just really think give`.split(
		/\s+/,
	),
);

/**
 * Trainees speak loosely; the note uses textbook terms. A small, explicit synonym
 * table bridges the gap ("the left eye" in this case is "the fellow eye").
 * Kept deliberately short and reviewable rather than learned.
 */
const EXPANSIONS: [RegExp, string][] = [
	[/\b(left|other|second|opposite)\s+eye\b/i, "fellow eye prophylactic"],
	[/\b(both|two)\s+eyes\b/i, "fellow eye prophylactic"],
	[/\blaser\b/i, "laser peripheral iridotomy LPI"],
	[/\bdrops?\b/i, "topical"],
	[/\b(pressure|pressures)\b/i, "IOP"],
	[/\bnarrow\b/i, "angle closure"],
	[/\bdiamox\b/i, "acetazolamide"],
	[/\bpilo\b/i, "pilocarpine"],
	[/\b(sulpha|sulfa|sulfonamide|sulphonamide)\b/i, "sulfonamide allergy"],
	[/\bdoesn'?t (come|go) down|not (falling|coming down)|refractory\b/i, "does not fall"],
];

export function expandQuery(q: string): string {
	const lower = q.toLowerCase();
	const extra = EXPANSIONS.filter(([re]) => re.test(q))
		.map(([, add]) =>
			// only add the terms the query does not already use, so expansion never re-weights them
			add
				.split(" ")
				.filter((w) => !lower.includes(w.toLowerCase()))
				.join(" "),
		)
		.filter(Boolean);
	return extra.length ? `${q} ${extra.join(" ")}` : q;
}

export function createRetriever(index: ReferenceIndex) {
	const mini = new MiniSearch<{
		id: string;
		heading: string;
		text: string;
	}>({
		fields: ["heading", "text"],
		storeFields: ["id"],
		processTerm: (term) => {
			const t = term.toLowerCase();
			return STOPWORDS.has(t) ? null : t;
		},
		searchOptions: {
			boost: { heading: 2 },
			prefix: (term) => term.length > 4,
			fuzzy: (term) => (term.length > 6 ? 0.15 : false),
			combineWith: "OR",
		},
	});
	mini.addAll(
		index.chunks.map((c) => ({
			id: c.id,
			heading: chunkHeading(c),
			text: chunkText(c),
		})),
	);
	const byId = new Map(index.chunks.map((c) => [c.id, c]));

	return {
		search(query: string, k = 4): Retrieved[] {
			return mini
				.search(expandQuery(query))
				.slice(0, k)
				.flatMap((r) => {
					const chunk = byId.get(r.id);
					return chunk ? [{ chunk, score: r.score }] : [];
				});
		},
		/**
		 * Several queries fused by reciprocal rank (RRF, k=60), so one long query
		 * cannot drown out a short, specific one (e.g. the follow-up exchange).
		 */
		searchMany(queries: string[], k = 5): Retrieved[] {
			const fused = new Map<string, number>();
			for (const q of queries.filter((q) => q.trim())) {
				mini.search(expandQuery(q)).slice(0, 20).forEach((r, rank) => {
					fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (60 + rank + 1));
				});
			}
			return [...fused.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, k)
				.flatMap(([id, score]) => {
					const chunk = byId.get(id);
					return chunk ? [{ chunk, score: score * 1000 }] : [];
				});
		},
		get: (id: string) => byId.get(id),
	};
}

export type Retriever = ReturnType<typeof createRetriever>;

/* ------------------------------------------------------- quote verification */

const normalise = (s: string) =>
	s
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim();

/**
 * True when the excerpt appears verbatim in the chunk (modulo case, whitespace
 * and typographic quotes). An excerpt elided with "..." must match piecewise,
 * in order. This is the guard that stops a fluent but invented citation.
 */
export function excerptIsVerbatim(
	excerpt: string,
	chunk: ReferenceChunk,
): boolean {
	const haystack = normalise(chunk.blocks.join(" "));
	const parts = normalise(excerpt)
		.replace(/^["']|["']$/g, "")
		.split(/\s*(?:\.\.\.|…)\s*/)
		.filter((p) => p.length > 0);
	if (parts.length === 0) return false;
	let from = 0;
	for (const part of parts) {
		const at = haystack.indexOf(part, from);
		if (at < 0) return false;
		from = at + part.length;
	}
	return true;
}
