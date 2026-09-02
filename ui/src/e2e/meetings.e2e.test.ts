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
  utteranceCount: 42,
  participants: ["Ada", "Sam", "Jo", "Alex"],
  hasSummary: true,
  summarySource: "model",
  overview: "Agreed on a simpler onboarding flow and a focused launch checklist.",
};
const detail: TranscriptsGetResult = {
  session: meeting,
  summary: {
    generatedAt: "2026-08-12T17:45:00Z",
    overview: meeting.overview!,
    decisions: [],
    actionItems: [],
    risks: [],
    participants: meeting.participants,
    source: "model",
    markdown:
      "# Design review\n\n## Overview\nAgreed on a simpler onboarding flow and a focused launch checklist.\n\n## Decisions\n- Keep the first-run setup to three steps.\n- Ship the accessible navigation before launch.\n\n## Action Items\n- Ada: prepare the revised prototype.\n- Sam: review keyboard navigation.\n\n## Risks\n- Leave time for mobile testing.",
  },
};

suite.define(() => {
  it("groups meetings, opens shareable notes, and loads transcript only on expansion", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", colorScheme: "light" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "transcripts.list": {
              sessions: [
                meeting,
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
              cases: [
                {
                  match: { includeUtterances: true },
                  response: {
                    ...detail,
                    utterances: [
                      { sequence: 0, speakerLabel: "Ada", text: "Let's keep the setup simple." },
                    ],
                  },
                },
                { match: { selector: meeting.selector }, response: detail },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}meetings`);
        const view = page.locator("openclaw-meetings-page");
        await view.getByRole("button", { name: /Design review/ }).waitFor();
        expect(await view.locator(".meetings-day h2").allTextContents()).toEqual([
          "August 12, 2026",
          "August 11, 2026",
        ]);
        expect(await gateway.getRequests("transcripts.list")).toMatchObject([
          { params: { limit: 200 } },
        ]);
        expect(await gateway.getRequests("transcripts.get")).toHaveLength(0);
        await view.getByRole("button", { name: /Design review/ }).click();
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get("selector")).toBe(meeting.selector);
        expect(
          await view.getByText("Ada: prepare the revised prototype.", { exact: true }).isVisible(),
        ).toBe(true);
        for (const request of await gateway.getRequests("transcripts.get")) {
          expect(request.params).not.toHaveProperty("includeUtterances", true);
        }
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          await page.screenshot({
            path: path.join(suite.artifactDir, `meetings-${theme}.png`),
            animations: "disabled",
          });
        }
        await view.locator(".meetings-transcript summary").click();
        await view.getByText("Let's keep the setup simple.", { exact: false }).waitFor();
        expect((await gateway.getRequests("transcripts.get")).at(-1)?.params).toEqual({
          selector: meeting.selector,
          includeUtterances: true,
        });
        await page.reload();
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
      },
    );
  });

  it("shows an actionable empty state and refreshes without hiding errors", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "transcripts.list": { sessions: [] } },
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
