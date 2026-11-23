import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end test of a whole viva in a real browser, against the local
 * Firebase emulators and the real OpenAI models.
 *
 *   pnpm emulators          # terminal 1
 *   pnpm test:e2e           # terminal 2 (starts `pnpm dev:local` if needed)
 *
 * In CI the emulators are started by `pnpm test:e2e:ci`.
 */
const fakeMic = resolve("tests/e2e/fixtures/right-eye-pressure.wav");

export default defineConfig({
	testDir: "tests/e2e",
	timeout: 180_000,
	expect: { timeout: 60_000 },
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["github"], ["list"]] : "list",
	use: {
		baseURL: "http://localhost:3000",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				permissions: ["microphone"],
				launchOptions: {
					// Optional: point at an already-installed Chromium instead of downloading one.
					executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined,
					args: [
						// The microphone "hears" a recorded question instead of a real person.
						"--use-fake-ui-for-media-stream",
						"--use-fake-device-for-media-stream",
						`--use-file-for-fake-audio-capture=${fakeMic}`,
						"--autoplay-policy=no-user-gesture-required",
					],
				},
			},
		},
	],
	webServer: {
		command: "pnpm dev:local",
		url: "http://localhost:3000",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
