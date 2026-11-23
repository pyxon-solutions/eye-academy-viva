/**
 * Turns the reference-note PDF into page-scoped, heading-aware chunks.
 *
 *   pnpm preprocess:reference
 *
 * Structure comes from the PDF's own typography rather than regex guesses:
 *   ~15.5pt  → section heading      ~11.5pt → sub-section heading
 *   ~10.3pt  → body text            y<40 or y>800 → running header/footer
 * A vertical gap larger than a normal line (or a bold lead-in run) starts a new block,
 * which separates paragraphs, bullets and table rows.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDocumentProxy } from "unpdf";
import {
	type ReferenceChunk,
	type ReferenceIndex,
	ReferenceIndexSchema,
} from "../src/domain/reference/schema.ts";

const SRC = resolve("data/source/reference-note.pdf");
const OUT = resolve("data/reference-index.json");

const SECTION_MIN = 14;
const SUBSECTION_MIN = 11;
const BODY_MAX = 10.8;
const LINE_GAP_MAX = 18; // body leading is ~16.5pt; bullets/paragraphs are further apart
const TABLE_CELL_GAP = 12; // horizontal gap that separates table columns

type Item = {
	str: string;
	x: number;
	y: number;
	width: number;
	size: number;
	font: string;
};
type Line = { y: number; size: number; items: Item[] };

const round = (n: number) => Math.round(n * 10) / 10;

function toLines(items: Item[]): Line[] {
	const lines: Line[] = [];
	for (const it of items) {
		const line = lines.find((l) => Math.abs(l.y - it.y) < 2);
		if (line) line.items.push(it);
		else lines.push({ y: it.y, size: it.size, items: [it] });
	}
	for (const l of lines) {
		l.items.sort((a, b) => a.x - b.x);
		l.size = Math.max(...l.items.map((i) => i.size));
	}
	return lines.sort((a, b) => b.y - a.y);
}

type Cell = { x: number; text: string };

/** Splits a line into cells: runs of items separated by a wide horizontal gap. */
function lineCells(line: Line): Cell[] {
	const cells: Cell[] = [];
	let prev: Item | undefined;
	for (const it of line.items) {
		const gap = prev ? it.x - (prev.x + prev.width) : 0;
		if (!prev || gap > TABLE_CELL_GAP) cells.push({ x: it.x, text: it.str });
		else {
			const cell = cells[cells.length - 1];
			const needsSpace =
				gap > 1 && !cell.text.endsWith(" ") && !it.str.startsWith(" ");
			cell.text += (needsSpace ? " " : "") + it.str;
		}
		prev = it;
	}
	return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() }));
}

/** Appends a wrapped continuation line to the table row, column by column. */
function mergeIntoRow(row: Cell[], cont: Cell[]): Cell[] {
	const next = row.map((c) => ({ ...c }));
	for (const c of cont) {
		const target = next.reduce((best, col) =>
			Math.abs(col.x - c.x) < Math.abs(best.x - c.x) ? col : best,
		);
		target.text = joinWrapped(target.text, c.text);
	}
	return next;
}

const rowText = (row: Cell[]) => row.map((c) => c.text).join(" — ");

const joinWrapped = (a: string, b: string) =>
	a.endsWith("-") ? a + b : `${a} ${b}`;

async function main() {
	const pdf = await getDocumentProxy(new Uint8Array(await readFile(SRC)));
	const chunks: ReferenceChunk[] = [];
	let section = "Front matter";
	let subsection: string | null = null;
	let title = "";

	for (let p = 1; p <= pdf.numPages; p++) {
		const page = await pdf.getPage(p);
		const content = await page.getTextContent();
		const items: Item[] = content.items
			.filter((i) => "str" in i && i.str.trim() !== "")
			.map((i) => {
				const t = i as unknown as {
					str: string;
					transform: number[];
					width: number;
					fontName: string;
				};
				return {
					str: t.str,
					x: t.transform[4],
					y: t.transform[5],
					width: t.width,
					size: round(t.transform[0]),
					font: t.fontName,
				};
			})
			.filter((i) => i.y > 40 && i.y < 800);

		let current: ReferenceChunk | null = null;
		let block: string | null = null;
		let row: Cell[] | null = null;
		let lastY: number | null = null;

		const flushBlock = () => {
			const text = row ? rowText(row) : block;
			if (text && current) current.blocks.push(text);
			block = null;
			row = null;
		};
		const flushChunk = () => {
			flushBlock();
			if (current && current.blocks.length > 0) chunks.push(current);
			current = null;
		};
		const openChunk = () => {
			current = {
				id: `p${p}-${chunks.length + 1}`,
				page: p,
				section,
				subsection,
				blocks: [],
			};
		};

		for (const line of toLines(items)) {
			const cells = lineCells(line);
			const text = cells.map((c) => c.text).join(" ");
			if (line.size >= SECTION_MIN) {
				if (line.size > 20) {
					title = text; // document title on page 1
					continue;
				}
				flushChunk();
				section = text;
				subsection = null;
				lastY = null;
				continue;
			}
			if (line.size >= SUBSECTION_MIN && line.size > BODY_MAX) {
				flushChunk();
				subsection = text;
				lastY = null;
				continue;
			}
			if (line.size < 9) continue; // pills / captions under the title

			if (!current) openChunk();
			const gap = lastY === null ? Number.POSITIVE_INFINITY : lastY - line.y;
			const wrapped = gap <= LINE_GAP_MAX;
			const startsBold = line.items[0]?.font === boldFont(items);
			lastY = line.y;

			if (row && wrapped) {
				row = mergeIntoRow(row, cells);
			} else if (cells.length > 1) {
				flushBlock();
				row = cells;
			} else if (block !== null && wrapped && !startsBold && !row) {
				block = joinWrapped(block, text);
			} else {
				flushBlock();
				block = text;
			}
		}
		flushChunk();
	}

	const index: ReferenceIndex = ReferenceIndexSchema.parse({
		source: "Eye Academy - Glaucoma_and_Angle_Closure_Reference_Note.pdf",
		title,
		pageCount: pdf.numPages,
		generatedAt: new Date().toISOString(),
		chunks,
	});
	await writeFile(OUT, `${JSON.stringify(index, null, 2)}\n`);
	console.log(
		`Wrote ${index.chunks.length} chunks across ${index.pageCount} pages → ${OUT}`,
	);
	for (const c of index.chunks)
		console.log(
			`  p${c.page}  ${c.section}${c.subsection ? ` › ${c.subsection}` : ""}  (${c.blocks.length} blocks)`,
		);
}

/** The bold lead-in font is the 10.3pt font that is not the most common body font. */
let cachedBold: string | undefined;
function boldFont(items: Item[]): string | undefined {
	if (cachedBold) return cachedBold;
	const counts = new Map<string, number>();
	for (const i of items)
		if (i.size > 10 && i.size < BODY_MAX)
			counts.set(i.font, (counts.get(i.font) ?? 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	cachedBold = ranked[1]?.[0];
	return cachedBold;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
