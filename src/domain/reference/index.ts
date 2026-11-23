import raw from "../../../data/reference-index.json";
import { createRetriever } from "./retrieve";
import { ReferenceIndexSchema } from "./schema";

export const referenceIndex = ReferenceIndexSchema.parse(raw);
export const retriever = createRetriever(referenceIndex);

export * from "./retrieve";
export * from "./schema";
