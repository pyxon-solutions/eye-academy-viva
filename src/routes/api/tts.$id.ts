import { createFileRoute } from "@tanstack/react-router";
import { speechText, synthesize } from "#/server/speech";

/** Streams the examiner's voice for a line the server issued (see src/server/speech.ts). */
export const Route = createFileRoute("/api/tts/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const text = speechText(params.id);
				if (!text) return new Response("Not found", { status: 404 });
				return synthesize(text);
			},
		},
	},
});
