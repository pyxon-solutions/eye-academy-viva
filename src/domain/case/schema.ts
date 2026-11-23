import { z } from "zod";

export const EyeSchema = z.enum(["right", "left", "both"]).nullable();
export type Eye = z.infer<typeof EyeSchema>;

export const FindingSchema = z
	.object({
		id: z.string().min(1),
		eye: EyeSchema,
		label: z.string().min(1),
		value: z.union([z.string(), z.number()]).nullable(),
		unit: z.string().nullable(),
		method: z.string().nullable(),
		available: z.boolean(),
		unavailable_reason: z.string().optional(),
	})
	.refine((f) => f.available || f.unavailable_reason, {
		message: "Unavailable findings must say why",
		path: ["unavailable_reason"],
	});
export type Finding = z.infer<typeof FindingSchema>;

export const CaseSchema = z.object({
	case_id: z.string(),
	title: z.string(),
	fictional: z.literal(true),
	disclaimer: z.string(),
	opening_prompt: z.string(),
	patient: z.object({
		age: z.number(),
		sex: z.string(),
		presenting_complaint: z.string(),
		past_ocular_history: z.string(),
		past_medical_history: z.string(),
		medications: z.array(z.string()),
		allergies: z.string(),
		family_history: z.string(),
	}),
	findings: z.array(FindingSchema).min(1),
	examiner_notes: z.object({
		diagnosis: z.string(),
		key_points: z.array(z.string()),
		follow_up_ideas: z.array(z.string()).min(1),
	}),
	reference_source: z.object({
		title: z.string(),
		file: z.string(),
		note: z.string(),
	}),
});
export type VivaCase = z.infer<typeof CaseSchema>;
