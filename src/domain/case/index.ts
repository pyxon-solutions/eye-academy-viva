import raw from "../../../data/source/case-EA-VIVA-001.json";
import { buildCatalogue } from "./catalogue";
import { CaseSchema } from "./schema";

/** Parsed once at module load: a malformed case file fails fast, not mid-viva. */
export const vivaCase = CaseSchema.parse(raw);
export const catalogue = buildCatalogue(vivaCase);

export * from "./catalogue";
export * from "./format";
export * from "./schema";
