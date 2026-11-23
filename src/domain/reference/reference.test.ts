import { describe, expect, it } from "vitest";
import { excerptIsVerbatim, referenceIndex, retriever } from "./index";

const pagesFor = (q: string, k = 4) =>
	retriever.search(q, k).map((r) => r.chunk.page);

describe("preprocessed reference index", () => {
	it("covers all 10 pages and keeps page-scoped chunks", () => {
		expect(referenceIndex.pageCount).toBe(10);
		const pages = new Set(referenceIndex.chunks.map((c) => c.page));
		expect([...pages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("splits a sub-section that crosses a page into two chunks", () => {
		const immediate = referenceIndex.chunks.filter(
			(c) => c.subsection === "Immediate treatment",
		);
		expect(immediate.map((c) => c.page)).toEqual([5, 6]);
	});
});

describe("retrieval targets the acute angle closure section, not distractors", () => {
	it("fellow-eye iridotomy → page 6 definitive treatment", () => {
		const [top] = retriever.search("prophylactic laser iridotomy fellow eye");
		expect(top.chunk.page).toBe(6);
		expect(top.chunk.subsection).toBe("Definitive treatment");
	});

	it("pilocarpine at very high pressure → page 5 immediate treatment", () => {
		expect(pagesFor("pilocarpine ischaemic iris sphincter very high pressure")[0]).toBe(5);
	});

	it("acetazolamide with sulfonamide allergy → page 6 is retrieved", () => {
		expect(pagesFor("acetazolamide sulfonamide allergy")).toContain(6);
	});
});

describe("follow-up exchanges retrieve the passage that answers them (top 5, fused)", () => {
	const ids = (followUp: string, answer: string) =>
		retriever.searchMany([followUp, answer], 5).map((r) => r.chunk.id);

	it.each([
		["Why treat the left eye as well? Because it is also narrow.", "Angle closure, drops and laser the right eye.", "p6-20"],
		["Why might pilocarpine not work at first when the pressure is very high? The iris is ischaemic.", "Acetazolamide and pilocarpine.", "p5-17"],
		["What would you do if the pressure doesn't come down? Mannitol.", "Angle closure, topical drops, diamox.", "p6-19"],
	])("%s → %s", (followUp, answer, expected) => {
		expect(ids(followUp, answer)).toContain(expected);
	});
});

describe("citation guard", () => {
	const chunk = referenceIndex.chunks.find(
		(c) => c.page === 6 && c.subsection === "Definitive treatment",
	);
	if (!chunk) throw new Error("fixture chunk missing");

	it("accepts a verbatim excerpt (case and whitespace tolerant)", () => {
		expect(
			excerptIsVerbatim(
				"without treatment around 40 to 50% of fellow eyes have an attack within 5 to 10 years",
				chunk,
			),
		).toBe(true);
	});

	it("accepts an excerpt elided with an ellipsis, in order", () => {
		expect(
			excerptIsVerbatim("Prophylactic LPI in the fellow eye … Long-term pilocarpine is not an adequate alternative", chunk),
		).toBe(true);
	});

	it("rejects a paraphrase or an altered number", () => {
		expect(excerptIsVerbatim("around 30 to 50% of fellow eyes have an attack", chunk)).toBe(false);
		expect(excerptIsVerbatim("the other eye should also be lasered", chunk)).toBe(false);
	});
});
