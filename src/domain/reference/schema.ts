import { z } from "zod";

/**
 * A chunk is one sub-section of the reference note *on a single page*.
 * Sub-sections that cross a page break become two chunks that share a heading,
 * so every citation resolves to exactly one printed page number.
 */
export const ReferenceChunkSchema = z.object({
	id: z.string(),
	page: z.number().int().positive(),
	section: z.string(),
	subsection: z.string().nullable(),
	/** Paragraphs, bullets and table rows, in reading order. */
	blocks: z.array(z.string().min(1)).min(1),
});

export const ReferenceIndexSchema = z.object({
	source: z.string(),
	title: z.string(),
	pageCount: z.number().int().positive(),
	generatedAt: z.string(),
	chunks: z.array(ReferenceChunkSchema).min(1),
});

export type ReferenceChunk = z.infer<typeof ReferenceChunkSchema>;
export type ReferenceIndex = z.infer<typeof ReferenceIndexSchema>;

export const chunkText = (c: ReferenceChunk): string => c.blocks.join("\n");

export const chunkHeading = (c: ReferenceChunk): string =>
	c.subsection ? `${c.section} › ${c.subsection}` : c.section;
