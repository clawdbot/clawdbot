import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-progress-hovercard",
);

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders safe progress markdown and refreshes the hovered card after a change event", async () => {
    const selectedSessionKey = "agent:main:selected";
    const sessionKey = "agent:main:building-release";
    const initialMarkdown = [
      "**Building** phase 2",
      "",
      '<progress value="3" max="7"></progress>',
      "",
      "| step | state |",
      "| --- | --- |",
      "| tests | green |",
      "",
      '<span onclick="window.__progressCardPwned = true">unsafe</span>',
      "<script>window.__progressCardPwned = true</script>",
    ].join("\n");

    await suite.withPage(
      {
        colorScheme: "dark",
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": {
              cases: [
                {
                  match: { sessionKey: selectedSessionKey },
                  response: { card: null },
                },
                {
                  match: { sessionKey },
                  response: {
                    card: {
                      markdown: initialMarkdown,
                      revision: 1,
                      sessionKey,
                      steps: [
                        { step: "Inspect", status: "completed" },
                        { step: "Package", status: "in_progress" },
                        { step: "Publish", status: "pending" },
                      ],
                      updatedAt: 1,
                    },
                  },
                },
              ],
            },
            "sessions.list": chatSessionListResponse([
              {
                key: selectedSessionKey,
                kind: "direct",
                label: "Selected session",
                updatedAt: 3,
              },
              {
                key: sessionKey,
                kind: "direct",
                label: "Building release",
                updatedAt: 2,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);

        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();

        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        await expect.poll(() => card.locator("strong").textContent()).toContain("Building");

        const progress = card.locator("progress");
        await expect.poll(() => progress.getAttribute("value")).toBe("3");
        expect(await progress.getAttribute("max")).toBe("7");
        expect(await card.locator("table").count()).toBe(1);
        expect(await card.getByRole("cell", { name: "tests" }).count()).toBe(1);
        expect(await card.getByRole("cell", { name: "green" }).count()).toBe(1);
        expect(await card.locator("script").count()).toBe(0);
        expect(await card.locator("[onclick]").count()).toBe(0);
        expect(await card.textContent()).not.toContain("progressCardPwned");
        await expect
          .poll(() => card.locator(".session-progress-card__heading").textContent())
          .toContain("1/3");
        await expect
          .poll(() => card.locator(".session-progress-card__step--completed").textContent())
          .toContain("Inspect");
        await expect
          .poll(() => card.locator(".session-progress-card__step--in_progress").textContent())
          .toContain("Package");
        await expect
          .poll(() => card.locator(".session-progress-card__step--pending").textContent())
          .toContain("Publish");
        expect(await page.evaluate(() => "__progressCardPwned" in window)).toBe(false);
        await captureProof(page, "sidebar-hovercard-open.png");

        await gateway.setMethodResponse("progressCard.get", {
          cases: [
            { match: { sessionKey: selectedSessionKey }, response: { card: null } },
            {
              match: { sessionKey },
              response: {
                card: {
                  markdown: '**Packaging** phase 3\n\n<progress value="6" max="7"></progress>',
                  revision: 2,
                  sessionKey,
                  steps: [
                    { step: "Inspect", status: "completed" },
                    { step: "Package", status: "completed" },
                    { step: "Publish", status: "in_progress" },
                  ],
                  updatedAt: 2,
                },
              },
            },
          ],
        });
        await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });

        await expect.poll(() => card.textContent()).toContain("Packaging");
        await expect.poll(() => card.locator("progress").getAttribute("value")).toBe("6");
        await expect
          .poll(() => card.locator(".session-progress-card__heading").textContent())
          .toContain("2/3");
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("progressCard.get")).filter(
                (request) => isRecord(request.params) && request.params.sessionKey === sessionKey,
              ).length,
          )
          .toBe(2);
        await captureProof(page, "hovercard-updated.png");
      },
    );
  });

  it("keeps the hover surface closed when the session has no progress card", async () => {
    const sessionKey = "agent:main:no-progress-card";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "No progress card",
                updatedAt: 1,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();

        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
        await expect.poll(() => page.locator(".session-progress-hovercard").count()).toBe(0);
      },
    );
  });
});
