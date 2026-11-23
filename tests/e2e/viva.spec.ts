import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * A whole viva as a trainee would do it, in a real browser:
 * voice question through a fake microphone, an unavailable finding, a request
 * the case doesn't contain, an answer, the follow-up, the revision point,
 * a reload, and a second trainee who must not see the attempt.
 */

async function signUp(page: Page, who: string) {
	await page.goto("/");
	await page.getByText("Test account (local emulator only)").click();
	await page.getByLabel("Email").fill(`${who}-${Date.now()}@example.com`);
	await page.getByLabel("Password").fill("secret123");
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(
		page.getByRole("button", { name: "Start a new viva" }),
	).toBeVisible();
}

const status = (page: Page) => page.getByRole("status");
const examinerTurns = (page: Page) =>
	page.locator("main ol > li").filter({ hasText: "Examiner" });

async function waitForExaminer(page: Page, count: number) {
	await expect(examinerTurns(page)).toHaveCount(count);
	await expect(status(page)).toHaveText(/Your turn|Viva complete/);
}

async function type(page: Page, text: string, examinerCount: number) {
	await page.getByPlaceholder("…or type instead").fill(text);
	await page.getByRole("button", { name: "Send" }).click();
	await waitForExaminer(page, examinerCount);
}

test("a trainee completes a viva and only they can reopen it", async ({
	page,
	browser,
}) => {
	await signUp(page, "trainee");
	await page.getByRole("button", { name: "Start a new viva" }).click();
	await expect(page).toHaveURL(/\/viva\//);
	const vivaUrl = page.url().split("?")[0];
	await expect(
		page.getByText("Ask me for any examination findings"),
	).toBeVisible();
	await expect(status(page)).toHaveText(/Your turn/);

	// 1. Voice: the fake microphone asks "What is the pressure in the right eye?"
	await page.getByRole("button", { name: "Start speaking" }).click();
	await expect(status(page)).toHaveText(/Listening/);
	await page.waitForTimeout(3_500);
	await page.getByRole("button", { name: "Stop and send" }).click();
	await waitForExaminer(page, 2);
	const lastExaminer = examinerTurns(page).last();
	await expect(lastExaminer).toContainText(
		"Right eye · Intraocular pressure: 58 mmHg",
	);
	await expect(lastExaminer).not.toContainText("Left eye");
	await expect(lastExaminer).toContainText(/voice turn \d+\.\ds/);

	// 2. Unavailable finding, plus something the case doesn't contain
	await type(page, "Can I see the right fundus and the visual fields?", 3);
	await expect(examinerTurns(page).last()).toContainText(
		"Right eye · Optic disc and fundus: not available (Poor view through oedematous cornea)",
	);
	await expect(examinerTurns(page).last()).toContainText(
		"visual fields: not available in this case",
	);
	const revealed = page.locator("aside");
	await expect(revealed).toContainText("Intraocular pressure: 58 mmHg");
	await expect(revealed).not.toContainText("Visual acuity");

	// 3. Answer → one follow-up question
	await type(
		page,
		"This is right acute primary angle closure. Timolol, apraclonidine, IV acetazolamide, then laser iridotomy to the right eye.",
		4,
	);
	await expect(examinerTurns(page).last()).toContainText("?");

	// 4. Follow-up answer → revision point with a page and an excerpt, or an explicit "no support"
	await type(
		page,
		"Because the left angle is narrow on gonioscopy so it is at risk too.",
		5,
	);
	await expect(status(page)).toHaveText(/Viva complete/);
	const revision = page
		.locator("h2", { hasText: "Revision point" })
		.locator("..");
	await expect(revision).toBeVisible();
	await expect(revision).toContainText(
		/Eye Academy reference note, page \d+|couldn't find a passage/,
	);

	// 5. A refresh brings the whole attempt back
	await page.reload();
	await expect(examinerTurns(page)).toHaveCount(5);
	await expect(page.locator("main ol > li")).toHaveCount(9);
	await expect(revision).toBeVisible();

	// 6. Another trainee cannot open it
	await expectAttemptHidden(browser, vivaUrl);
});

async function expectAttemptHidden(browser: Browser, url: string) {
	const other = await (await browser.newContext()).newPage();
	await signUp(other, "intruder");
	await other.goto(url);
	await expect(other.getByText("Attempt not found.")).toBeVisible();
	await other.context().close();
}
