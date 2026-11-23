import { readFileSync } from "node:fs";
import {
	assertFails,
	assertSucceeds,
	initializeTestEnvironment,
	type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
	collection,
	doc,
	getDoc,
	getDocs,
	query,
	setDoc,
	updateDoc,
	where,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

let env: RulesTestEnvironment;

beforeAll(async () => {
	env = await initializeTestEnvironment({
		projectId: "demo-eye-academy",
		firestore: { rules: readFileSync("firestore.rules", "utf8") },
	});
});
afterAll(() => env.cleanup());

beforeEach(async () => {
	await env.clearFirestore();
	await env.withSecurityRulesDisabled(async (ctx) => {
		const db = ctx.firestore();
		await setDoc(doc(db, "attempts/alice-1"), { uid: "alice", caseId: "EA-VIVA-001" });
		await setDoc(doc(db, "attempts/bob-1"), { uid: "bob", caseId: "EA-VIVA-001" });
	});
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();

describe("attempts are private to their owner", () => {
	it("owner can read their attempt", async () => {
		await assertSucceeds(getDoc(doc(as("alice"), "attempts/alice-1")));
	});

	it("another trainee cannot read it", async () => {
		await assertFails(getDoc(doc(as("bob"), "attempts/alice-1")));
	});

	it("signed-out visitors cannot read it", async () => {
		await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "attempts/alice-1")));
	});

	it("owner can list their own attempts with a uid filter", async () => {
		const db = as("alice");
		await assertSucceeds(getDocs(query(collection(db, "attempts"), where("uid", "==", "alice"))));
	});

	it("listing without the uid filter, or for someone else, is denied", async () => {
		const db = as("alice");
		await assertFails(getDocs(collection(db, "attempts")));
		await assertFails(getDocs(query(collection(db, "attempts"), where("uid", "==", "bob"))));
	});
});

describe("clients cannot write attempts directly", () => {
	it("owner cannot create, edit or forge revealed findings", async () => {
		const db = as("alice");
		await assertFails(setDoc(doc(db, "attempts/alice-2"), { uid: "alice" }));
		await assertFails(updateDoc(doc(db, "attempts/alice-1"), { revealed: ["iop_right"] }));
	});
});
