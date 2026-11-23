import { useCallback, useEffect, useRef, useState } from "react";

/** Picks a recording format the browser supports and the transcription API accepts. */
function pickMime(): { mime: string; ext: string } {
	const options = [
		{ mime: "audio/webm;codecs=opus", ext: "webm" },
		{ mime: "audio/webm", ext: "webm" },
		{ mime: "audio/mp4", ext: "mp4" },
	];
	return (
		options.find(
			(o) =>
				typeof MediaRecorder !== "undefined" &&
				MediaRecorder.isTypeSupported(o.mime),
		) ?? options[0]
	);
}

/** Tap-to-start / tap-to-stop microphone recorder. */
export function useRecorder() {
	const recorder = useRef<MediaRecorder | null>(null);
	const chunks = useRef<Blob[]>([]);
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const start = useCallback(async () => {
		setError(null);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const { mime } = pickMime();
			const rec = new MediaRecorder(stream, { mimeType: mime });
			chunks.current = [];
			rec.ondataavailable = (e) =>
				e.data.size > 0 && chunks.current.push(e.data);
			rec.start();
			recorder.current = rec;
			setRecording(true);
		} catch {
			setError(
				"Microphone unavailable. Allow microphone access, or type your answer instead.",
			);
		}
	}, []);

	/** Stops recording and resolves with the audio as a File ready to upload. */
	const stop = useCallback(
		() =>
			new Promise<File | null>((resolve) => {
				const rec = recorder.current;
				if (!rec) return resolve(null);
				rec.onstop = () => {
					for (const t of rec.stream.getTracks()) t.stop();
					recorder.current = null;
					setRecording(false);
					const { mime, ext } = pickMime();
					const blob = new Blob(chunks.current, { type: mime.split(";")[0] });
					resolve(
						blob.size > 0
							? new File([blob], `turn.${ext}`, { type: blob.type })
							: null,
					);
				};
				rec.stop();
			}),
		[],
	);

	useEffect(() => () => recorder.current?.stop(), []);
	return { recording, start, stop, error };
}

/**
 * Plays the examiner's voice. The <audio> element streams `/api/tts/<id>`, so the
 * `playing` event marks first audible audio — the end of our voice-turn timer.
 */
export function usePlayer() {
	const audio = useRef<HTMLAudioElement | null>(null);
	const [speaking, setSpeaking] = useState(false);

	const play = useCallback(
		(speechId: string) =>
			new Promise<{ firstAudioAt: number | null }>((resolve) => {
				audio.current?.pause();
				const el = new Audio(`/api/tts/${speechId}`);
				audio.current = el;
				let firstAudioAt: number | null = null;
				const done = () => {
					setSpeaking(false);
					resolve({ firstAudioAt });
				};
				el.addEventListener("playing", () => {
					firstAudioAt ??= performance.now();
				});
				el.addEventListener("ended", done);
				el.addEventListener("error", done);
				el.addEventListener("pause", () => el.ended || done());
				setSpeaking(true);
				el.play().catch(done); // autoplay blocked → text is still on screen
			}),
		[],
	);

	const stop = useCallback(() => audio.current?.pause(), []);
	useEffect(() => () => audio.current?.pause(), []);
	return { speaking, play, stop };
}
