import path from "node:path";
import type { TranscriptSessionSummary, TranscriptsGetResult } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Meetings dashboard" });
const meeting: TranscriptSessionSummary = {
  selector: "2026-08-12/design-review",
  sessionId: "design-review",
  title: "Design review",
  providerId: "discord-voice",
  providerName: "Discord voice",
  source: { providerId: "discord-voice" },
  startedAt: "2026-08-12T17:00:00Z",
  stoppedAt: "2026-08-12T17:45:00Z",
  active: false,
  activeSubscription: false,
  agentId: "main",
  updatedAt: "2026-08-12T17:45:00Z",
  lastUtteranceAt: "2026-08-12T17:44:00Z",
  utteranceCount: 42,
  participants: ["Ada", "Sam", "Jo", "Alex"],
  hasSummary: true,
  summarySource: "model",
  overview: "Agreed on a simpler onboarding flow and a focused launch checklist.",
};
const detail: TranscriptsGetResult = {
  session: meeting,
  nextCursor: null,
  summary: {
    generatedAt: "2026-08-12T17:45:00Z",
    overview: meeting.overview!,
    decisions: [],
    actionItems: [],
    risks: [],
    participants: meeting.participants,
    utteranceCount: meeting.utteranceCount,
    source: "model",
    markdown:
      "# Design review\n\n## Overview\nAgreed on a simpler onboarding flow and a focused launch checklist.\n\n## Participants\n- Ada\n- Sam\n- Jo\n- Alex\n\n## Decisions\n- Keep the first-run setup to three steps.\n- Ship the accessible navigation before launch.\n\n## Action Items\n- Ada: prepare the revised prototype.\n- Sam: review keyboard navigation.\n\n## Risks\n- Leave time for mobile testing.\n\n## Transcript\n- Ada: Let's keep the setup simple.",
  },
};

suite.define(() => {
  it("groups meetings, marks silent captures, and opens shareable notes without duplicate transcripts", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", colorScheme: "light" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "transcripts.list": {
              nextCursor: null,
              sessions: [
                meeting,
                {
                  ...meeting,
                  selector: "2026-08-12/quiet-check-in",
                  sessionId: "quiet-check-in",
                  title: "Quiet check-in",
                  startedAt: "2026-08-12T16:00:00Z",
                  stoppedAt: "2026-08-12T16:01:00Z",
                  utteranceCount: 0,
                  participants: [],
                  summarySource: "heuristic",
                  overview: "No transcript captured yet.",
                },
                {
                  ...meeting,
                  selector: "2026-08-11/planning",
                  sessionId: "planning",
                  title: "Launch planning",
                  startedAt: "2026-08-11T09:00:00Z",
                  stoppedAt: "2026-08-11T09:45:00Z",
                  summarySource: "heuristic",
                },
              ],
            },
            "transcripts.get": {
              cases: [{ match: { selector: meeting.selector }, response: detail }],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}meetings`);
        const view = page.locator("openclaw-meetings-page");
        await view.getByRole("link", { name: /Design review/ }).waitFor();
        expect(await view.locator(".meetings-day h2").allTextContents()).toEqual([
          "August 12, 2026",
          "August 11, 2026",
        ]);
        expect(await gateway.getRequests("transcripts.list")).toMatchObject([
          { params: { limit: 50 } },
        ]);
        expect(await gateway.getRequests("transcripts.get")).toHaveLength(0);
        const silentRow = view.getByRole("link", { name: /Quiet check-in/ });
        expect.soft(await silentRow.textContent()).toContain("No speech captured");
        expect.soft(await silentRow.textContent()).not.toContain("No transcript captured yet.");
        await view.getByRole("link", { name: /Design review/ }).click();
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get("selector")).toBe(meeting.selector);
        expect(
          await view.getByText("Ada: prepare the revised prototype.", { exact: true }).isVisible(),
        ).toBe(true);
        expect(await view.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe(
          "true",
        );
        expect(await view.getByRole("heading", { name: "Transcript", exact: true }).count()).toBe(
          1,
        );
        expect(
          await view.getByText("Ada: Let's keep the setup simple.", { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          (await gateway.getRequests("transcripts.get")).map((request) => request.params),
        ).toEqual(
          expect.arrayContaining([
            { selector: meeting.selector },
            { selector: meeting.selector, includeUtterances: true, limit: 50 },
          ]),
        );
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          const mutedColor = await silentRow
            .locator(".meetings-row__meta")
            .first()
            .evaluate((element) => getComputedStyle(element).color);
          expect
            .soft(
              await silentRow
                .locator(".meetings-row__title")
                .evaluate((element) => getComputedStyle(element).color),
            )
            .toBe(mutedColor);
          await page.screenshot({
            path: path.join(suite.artifactDir, `meetings-${theme}.png`),
            animations: "disabled",
          });
        }
        await page.reload();
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        expect(
          (await gateway.getRequests("transcripts.get")).map((request) => request.params),
        ).toEqual(
          expect.arrayContaining([
            { selector: meeting.selector },
            { selector: meeting.selector, includeUtterances: true, limit: 50 },
          ]),
        );
      },
    );
  });

  it("shows an actionable empty state and refreshes without hiding errors", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "transcripts.list": { sessions: [], nextCursor: null } },
      });
      await page.goto(`${suite.server.baseUrl}meetings`);
      const view = page.locator("openclaw-meetings-page");
      await view.getByRole("heading", { name: "Your meeting notes, together" }).waitFor();
      expect(
        await view.getByRole("link", { name: "Set up meeting transcripts" }).getAttribute("href"),
      ).toBe("https://docs.openclaw.ai/cli/transcripts");
      await gateway.setMethodResponse("transcripts.list", {
        __mockError: { code: "UNAVAILABLE", message: "Meetings temporarily unavailable" },
      });
      await view.getByRole("button", { name: "Refresh", exact: true }).click();
      await view.getByRole("alert").waitFor();
      expect(await view.getByRole("alert").textContent()).toContain(
        "Meetings temporarily unavailable",
      );
      expect(
        await view.getByRole("heading", { name: "Your meeting notes, together" }).count(),
      ).toBe(0);
    });
  });
});
