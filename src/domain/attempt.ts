/**
 * Shape of a saved viva attempt (Firestore `attempts/{id}`), shared by server and client.
 * Written only by the server; readable only by its owner (see firestore.rules).
 */
export type Phase = "findings" | "follow_up" | "completed";

export type FindingLine = {
	/** Finding id from the case file, or null when the trainee asked for something not in the case. */
	findingId: string | null;
	kind: "available" | "unavailable" | "not_in_case";
	/** Verbatim on-screen line, e.g. "Right eye · Intraocular pressure: 58 mmHg". */
	line: string;
};

export type Turn = {
	role: "examiner" | "trainee";
	/** On-screen text. For the examiner this is verbatim case text; never the TTS rewrite. */
	text: string;
	/** What the examiner says aloud (clinical notation expanded for TTS). */
	speech?: string;
	findings?: FindingLine[];
	tag?: "opening" | "findings" | "prompt" | "follow_up" | "closing";
	at: number;
	/** Voice-turn timing, recorded for the responsiveness write-up. */
	timings?: Record<string, number>;
};

export type RevisionView =
	| {
			supported: true;
			point: string;
			page: number;
			heading: string;
			excerpt: string;
			retrievedPages: number[];
	  }
	| {
			supported: false;
			message: string;
			reason: string;
			retrievedPages: number[];
	  };

export type Attempt = {
	uid: string;
	caseId: string;
	phase: Phase;
	createdAt: number;
	updatedAt: number;
	transcript: Turn[];
	/** Finding ids revealed so far (available or explicitly unavailable), in the order first asked. */
	revealed: string[];
	answer: string | null;
	followUp: {
		question: string;
		respondsTo: string;
		answer: string | null;
	} | null;
	revision: (RevisionView & { chunkId?: string; retrieved?: unknown }) | null;
};
