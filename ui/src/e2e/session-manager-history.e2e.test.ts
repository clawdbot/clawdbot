import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateMenuItem,
  controlUiSessionPath,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session manager and history primary QA",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-manager-history",
);

async function captureUiProof(page: Page, fileName: string) {
  if (!captureProof) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

suite.define(() => {
  it("covers session listing, filtering, transcript history, and archive feedback", async () => {
    const timestamp = Date.parse("2026-08-03T09:00:00.000Z");
    const main = sessionRow("agent:main:main", "Main", timestamp);
    const research = sessionRow("agent:main:research", "Research notes", timestamp - 60_000);
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "sessions.search"],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "The deployment history is ready to review." }],
              timestamp,
            },
          ],
          methodResponses: {
            "sessions.list": sessionsListResponse([main, research]),
            "sessions.patch": {},
            "sessions.search": {
              results: [
                {
                  messageId: "message-research",
                  role: "assistant",
                  score: 2.5,
                  sessionId: "research",
                  sessionKey: research.key,
                  snippet: "The deployment history is ready to review.",
                  timestamp,
                },
              ],
            },
          },
          sessionKey: main.key,
        });

        await page.goto(`${suite.server.baseUrl}sessions`);
        const mainRow = page
          .locator(".session-data-row")
          .filter({ has: page.locator(`.session-label-chip[title="${main.label}"]`) });
        const researchRow = page
          .locator(".session-data-row")
          .filter({ has: page.locator(`.session-label-chip[title="${research.label}"]`) });
        await mainRow.waitFor({ state: "visible", timeout: 10_000 });
        await researchRow.waitFor({ state: "visible", timeout: 10_000 });

        const rosterFilter = page.locator('.sessions-toolbar__search input[type="text"]');
        await rosterFilter.fill("Research");
        await expect.poll(() => mainRow.count()).toBe(0);
        await researchRow.waitFor({ state: "visible" });
        await captureUiProof(page, "01-session-filter.png");
        await rosterFilter.fill("");
        await mainRow.waitFor({ state: "visible" });

        const transcriptSearch = page.getByRole("search", { name: "Search transcripts" });
        const transcriptInput = transcriptSearch.getByRole("searchbox", {
          name: "Search thread transcripts",
        });
        await transcriptInput.fill("deployment history");
        await transcriptInput.press("Enter");
        const result = page.locator(".sessions-transcript-search__result");
        await result.waitFor({ state: "visible", timeout: 10_000 });
        expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
          agentId: "main",
          limit: 25,
          query: "deployment history",
          sessionKeys: [main.key, research.key],
        });
        await result.click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(research.key));
        await page
          .locator(".chat-group.assistant")
          .getByText("The deployment history is ready to review.", { exact: true })
          .waitFor({ state: "visible", timeout: 10_000 });
        await captureUiProof(page, "02-session-history.png");

        await page.goto(`${suite.server.baseUrl}sessions`);
        const actionRow = page
          .locator(".session-data-row")
          .filter({ has: page.locator(`.session-label-chip[title="${research.label}"]`) });
        await actionRow.waitFor({ state: "visible", timeout: 10_000 });
        await actionRow.getByRole("button", { name: "Open thread menu" }).click();
        await activateMenuItem(
          page.locator("openclaw-session-menu").getByRole("menuitem", {
            name: "Archive thread",
          }),
        );
        const patch = await waitForPatch(
          gateway,
          (params) => params.key === research.key && params.archived === true,
        );
        expect(requireRecord(patch.params)).toMatchObject({
          archived: true,
          key: research.key,
        });
        const toast = page
          .locator("openclaw-toast-host .app-toast")
          .filter({ hasText: "Thread archived" });
        await toast.waitFor({ state: "visible", timeout: 10_000 });
        await toast.getByRole("button", { name: "Undo" }).waitFor({ state: "visible" });
        await captureUiProof(page, "03-session-archive-feedback.png");
      },
    );
  });
});
