import { defineConfig } from "vitest/config";

/** Firestore security-rules tests. Run with `pnpm test:rules` (starts the emulator). */
export default defineConfig({
	test: {
		include: ["tests/rules/**/*.test.ts"],
		environment: "node",
		testTimeout: 15_000,
	},
});
