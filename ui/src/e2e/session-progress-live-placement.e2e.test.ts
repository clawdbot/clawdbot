import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-progress-live-placement",
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
  it("keeps one live card placement and a compact transcript receipt", async () => {
    const sessionKey = "agent:main:progress-placement";
    const updatedAt = Date.now() - 5 * 60_000;
    const plan = [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" },
    ];

    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          historyMessages: [
            {
              id: "progress-receipt",
              role: "assistant",
              timestamp: 1,
              content: [
                {
                  type: "toolcall",
                  id: "progress-call",
                  name: "progress_card",
                  arguments: { markdown: "Implementation is moving.", plan },
                },
                {
                  type: "toolresult",
                  id: "progress-call",
                  name: "progress_card",
                  text: "Progress card updated (rev 2, 1/3 done)",
                },
              ],
            },
          ],
          methodResponses: {
            "progressCard.get": {
              card: {
                markdown: "**Implementation** is moving.",
                revision: 2,
                sessionKey,
                steps: plan,
                updatedAt,
              },
            },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Progress placement",
                updatedAt,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

        const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        const expectVisibleLastActivity = async (placement: "composer" | "dock" | "rail") => {
          const card = visiblePane.locator(`[data-progress-card-placement="${placement}"]`);
          const timestamp = card.locator("time");
          await expect
            .poll(() => timestamp.getAttribute("datetime"))
            .toBe(new Date(updatedAt).toISOString());
          await expect.poll(() => timestamp.getAttribute("aria-label")).toMatch(/^Last activity: /);
          await expect.poll(() => timestamp.textContent()).toMatch(/\d{1,2}:\d{2}:\d{2}/);
          await expect.poll(() => timestamp.isVisible()).toBe(true);
          const accessibleCard = placement === "composer" ? card.locator("summary") : card;
          await expect
            .poll(() => accessibleCard.getAttribute("aria-label"))
            .toContain("Last activity:");
          const timestampBounds = await timestamp.boundingBox();
          const cardBounds = await card.boundingBox();
          if (!timestampBounds || !cardBounds) {
            throw new Error("The progress card and last activity time must both remain visible");
          }
          expect(timestampBounds.x + timestampBounds.width).toBeLessThanOrEqual(
            cardBounds.x + cardBounds.width,
          );
        };
        // Wide enough for the composer gutter to hold the card: it docks beside
        // the composer instead of stacking inside it.
        await page.setViewportSize({ height: 900, width: 1600 });
        const dock = visiblePane.locator('[data-progress-card-placement="dock"]');
        await expect.poll(() => dock.count()).toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(0);
        await expect
          .poll(async () => {
            const dockBounds = await dock.boundingBox();
            const composerBounds = await visiblePane
              .locator(".agent-chat__composer-shell")
              .boundingBox();
            const threadBounds = await visiblePane.locator(".chat-thread").boundingBox();
            if (!dockBounds || !composerBounds || !threadBounds) {
              return false;
            }
            // Clear of the centered composer, and anchored to the top of the
            // conversation rather than floating above the composer.
            return (
              dockBounds.x >= composerBounds.x + composerBounds.width &&
              dockBounds.y < threadBounds.y + threadBounds.height / 2
            );
          })
          .toBe(true);
        await expectVisibleLastActivity("dock");
        await captureProof(page, "dock-beside-composer.png");

        await page.setViewportSize({ height: 900, width: 1280 });
        await openChatSidePanelType(page, "Side chat");
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(0);
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);

        const receipt = visiblePane.locator(".chat-thread .chat-progress-card-receipt");
        await expect
          .poll(() => receipt.textContent())
          .toContain("Progress updated — 1/3 · Implement");
        await expect.poll(() => receipt.locator(".chat-tool-msg-body").count()).toBe(0);
        await expect
          .poll(() => visiblePane.locator(".chat-thread").textContent())
          .not.toContain("Implementation is moving.");
        await expectVisibleLastActivity("rail");
        await captureProof(page, "rail-visible.png");

        await page.setViewportSize({ height: 900, width: 560 });
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        const sidePanel = visiblePane.locator(".sidebar-region__right-runtime .side-panel");
        await sidePanel.locator(".side-panel__minimize").click();
        await sidePanel.waitFor({ state: "hidden" });
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').isVisible())
          .toBe(true);
        await expectVisibleLastActivity("composer");
        await captureProof(page, "composer-adjacent.png");
      },
    );
  });

  it("stacks the docked card under a suggestion tray instead of letting it be covered", async () => {
    const sessionKey = "agent:main:progress-stacked";
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1600 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "taskSuggestions.list",
            "taskSuggestions.accept",
            "taskSuggestions.dismiss",
          ],
          methodResponses: {
            "progressCard.get": {
              card: {
                revision: 1,
                sessionKey,
                steps: [
                  { step: "Inspect", status: "completed" },
                  { step: "Implement", status: "in_progress" },
                ],
                updatedAt: 1,
              },
            },
            "taskSuggestions.list": {
              suggestions: [
                {
                  id: "task_stacked",
                  title: "Follow-up worth keeping",
                  prompt: "Inspect the related implementation and tests.",
                  tldr: "This tray must not cover the progress card.",
                  cwd: "/projects/example",
                  sessionKey: "main",
                  agentId: "main",
                  createdAt: 1,
                },
              ],
            },
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Stacked progress", updatedAt: 1 },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        const tray = visiblePane.locator(".task-suggestions");
        const dock = visiblePane.locator('[data-progress-card-placement="dock"]');
        await tray.waitFor({ state: "visible", timeout: 10_000 });
        await expect.poll(() => dock.count()).toBe(1);
        await expect
          .poll(async () => {
            const trayBounds = await tray.boundingBox();
            const dockBounds = await dock.boundingBox();
            if (!trayBounds || !dockBounds) {
              return false;
            }
            // The card sits fully below the tray, not underneath it.
            return dockBounds.y >= trayBounds.y + trayBounds.height;
          })
          .toBe(true);
        await captureProof(page, "stacked-under-tray.png");
      },
    );
  });

  it("centers the completed marker and dismisses the card across disclosure and reload", async () => {
    const sessionKey = "agent:main:progress-complete";
    const plan = [
      { step: "Inspected owner", status: "completed" },
      { step: "Implemented fix", status: "completed" },
      { step: "Filed issue", status: "completed" },
    ];

    for (const colorScheme of ["light", "dark"] as const) {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 560 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "progressCard.get",
              "progressCard.put",
            ],
            methodResponses: {
              "progressCard.get": {
                card: {
                  revision: 3,
                  sessionKey,
                  steps: plan,
                  updatedAt: 3,
                },
              },
              "progressCard.put": { card: null },
              "sessions.list": chatSessionListResponse([
                {
                  key: sessionKey,
                  kind: "direct",
                  label: "Completed progress",
                  updatedAt: 3,
                },
              ]),
            },
            sessionKey,
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
          const card = page.locator('[data-progress-card-placement="composer"]');
          await expect.poll(() => card.isVisible()).toBe(true);
          const expectMarkerCentered = async () => {
            await expect
              .poll(async () => {
                const summaryBounds = await card.locator("summary").boundingBox();
                const markerBounds = await card
                  .locator('.session-progress-card__current-marker[data-status="completed"]')
                  .boundingBox();
                if (!summaryBounds || !markerBounds) {
                  return Number.POSITIVE_INFINITY;
                }
                const summaryCenterY = summaryBounds.y + summaryBounds.height / 2;
                const markerCenterY = markerBounds.y + markerBounds.height / 2;
                return Math.abs(summaryCenterY - markerCenterY);
              })
              .toBeLessThanOrEqual(0.5);
          };
          await expectMarkerCentered();
          await card.locator("summary").click();
          await expectMarkerCentered();
          await captureProof(page, `completed-${colorScheme}-before.png`);

          await gateway.setMethodResponse("progressCard.put", {
            card: {
              revision: 4,
              sessionKey,
              steps: plan,
              updatedAt: MAX_DATE_TIMESTAMP_MS + 1,
            },
          });
          await card.getByRole("button", { name: "Dismiss progress card" }).click();
          await expect.poll(() => gateway.getRequests("progressCard.put")).toHaveLength(1);
          await page.getByText("Could not dismiss the progress card. Try again.").waitFor();
          await expect.poll(() => card.isVisible()).toBe(true);
          await expect
            .poll(() => card.locator("time").getAttribute("datetime"))
            .toBe(new Date(3).toISOString());

          await gateway.setMethodResponse("progressCard.put", { card: null });
          await card.getByRole("button", { name: "Dismiss progress card" }).click();
          const dismissRequest = await gateway.waitForRequest("progressCard.put", { after: 1 });
          expect(dismissRequest.params).toEqual({ sessionKey, expectedRevision: 3 });
          await expect.poll(() => card.count()).toBe(0);

          await page.locator("textarea").fill("rerender");
          await expect.poll(() => card.count()).toBe(0);
          await gateway.setMethodResponse("progressCard.get", { card: null });
          await page.reload();
          await page.locator("textarea").waitFor({ state: "visible" });
          await expect.poll(() => card.count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await captureProof(page, `completed-${colorScheme}-after.png`);
        },
      );
    }
  });

  it("keeps dismissal unavailable to a restricted session viewer", async () => {
    const sessionKey = "agent:main:progress-viewer";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 560 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get", "progressCard.put"],
          hasMultipleSessionSharingIdentities: true,
          methodResponses: {
            "progressCard.get": {
              card: {
                revision: 1,
                sessionKey,
                steps: [{ step: "Completed work", status: "completed" }],
                updatedAt: 1,
              },
            },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Restricted progress",
                sharingRole: "viewer",
                updatedAt: 1,
                visibility: "suggest",
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator('[data-progress-card-placement="composer"]');
        await expect.poll(() => card.isVisible()).toBe(true);
        await expect
          .poll(() => card.getByRole("button", { name: "Dismiss progress card" }).count())
          .toBe(0);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
      },
    );
  });
});
