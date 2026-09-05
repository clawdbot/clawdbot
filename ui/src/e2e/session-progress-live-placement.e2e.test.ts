import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import {
  focusChatSidePanel,
  openChatSidePanelType,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "session-progress-live-placement"), { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(path.join(suite.artifactDir, "session-progress-live-placement"), fileName),
  });
}

async function expectInsideProgressBody(item: Locator): Promise<void> {
  const inside = await item.evaluate((node) => {
    const itemBounds = node.getBoundingClientRect();
    const bodyBounds = node
      .closest<HTMLElement>(".session-progress-card__body")!
      .getBoundingClientRect();
    return itemBounds.bottom <= bodyBounds.bottom + 1 && itemBounds.top >= bodyBounds.top - 1;
  });
  expect(inside).toBe(true);
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("collapses each enabled run, expands its final, and preserves manual disclosure", async () => {
    const sessionKey = "agent:main:progress-final-expand";
    const proofDir = captureUiProofEnabled
      ? path.join(suite.artifactDir, "session-progress-live-placement")
      : null;
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(proofDir ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } } : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "config.get",
        "progressCard.get",
      ],
      methodResponses: {
        "progressCard.get": { card: null },
        "sessions.list": chatSessionListResponse([
          {
            key: sessionKey,
            kind: "direct",
            label: "Progress final expansion",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey,
    });
    const card = page.locator('[data-progress-card-placement="composer"]');
    const captureLifecycleState = async (fileName: string, surface = card) => {
      if (captureUiProofEnabled) {
        await page.waitForTimeout(250);
        await writeFile(
          path.join(suite.artifactDir, "session-progress-live-placement", fileName),
          await takeControlUiViewportScreenshot(page, surface, [surface]),
        );
        await page.waitForTimeout(500);
      }
    };
    const setProgressCard = async (
      revision: number,
      markdown: string,
      steps: Array<{ status: "completed" | "in_progress" | "pending"; step: string }>,
    ) => {
      await gateway.setMethodResponse("progressCard.get", {
        card: { markdown, revision, sessionKey, steps, updatedAt: Date.now() },
      });
      await gateway.emitGatewayEvent("progressCard.changed", { revision, sessionKey });
      await expect.poll(() => card.textContent()).toContain(markdown);
    };
    const send = async (message: string) => {
      const requestCount = (await gateway.getRequests("chat.send")).length;
      await page.locator(".agent-chat__composer-combobox textarea").fill(message);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("chat.send")).length)
        .toBe(requestCount + 1);
      const requests = await gateway.getRequests("chat.send");
      return requireString(
        requireRecord(requests[requestCount]!.params).idempotencyKey,
        "chat send idempotency key",
      );
    };

    try {
      await page.goto(
        `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
      );
      await waitForControlUiSettingsTakeover(page);
      const settingRow = page
        .locator(".settings-row")
        .filter({
          has: page.locator(".settings-row__title", {
            hasText: "Collapse task progress by default",
          }),
        })
        .first();
      const settingSwitch = settingRow.locator("wa-switch");
      await expect
        .poll(() =>
          settingSwitch.evaluate((element) => Boolean((element as { checked?: boolean }).checked)),
        )
        .toBe(false);
      await settingRow.click();
      await expect
        .poll(() =>
          settingSwitch.evaluate((element) => Boolean((element as { checked?: boolean }).checked)),
        )
        .toBe(true);
      await captureLifecycleState("01-setting-enabled.png", settingRow);

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const runOneId = await send("Run the first progress cycle");
      await setProgressCard(1, "Run one started", [
        { status: "in_progress", step: "Inspect first run" },
        { status: "pending", step: "Verify first run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("02-run-one-collapsed.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await setProgressCard(2, "Run one revised", [
        { status: "completed", step: "Inspect first run" },
        { status: "in_progress", step: "Verify first run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("03-run-one-manual-open-survives-update.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("04-run-one-manual-close-before-final.png");

      await gateway.emitChatFinal({
        runId: runOneId,
        sessionKey,
        text: "The first progress cycle is complete.",
      });
      await page
        .locator(".chat-bubble p", { hasText: "The first progress cycle is complete." })
        .waitFor();
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("05-run-one-final-auto-expanded.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await setProgressCard(3, "Run one final card revision", [
        { status: "completed", step: "Inspect first run" },
        { status: "completed", step: "Verify first run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("06-run-one-manual-close-survives-rerender.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("07-run-one-manual-reopen-before-next-run.png");

      await send("Run the second progress cycle");
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("08-run-two-active-collapsed.png");
      await setProgressCard(4, "Run two started", [
        { status: "in_progress", step: "Inspect second run" },
        { status: "pending", step: "Verify second run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("09-run-two-progress-collapsed.png");
    } finally {
      await page.close();
      if (proofDir && video) {
        const recordingPath = await video.path();
        await video.saveAs(path.join(proofDir, "task-progress-final-expand-cycle.webm"));
        await unlink(recordingPath);
      }
      await suite.closeBrowserContext(context);
    }
  });

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
                hasActiveRun: true,
                activeRunIds: ["stale-run"],
                status: "completed",
                updatedAt,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

        const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        const expectVisibleLastActivity = async (placement: "composer") => {
          const card = visiblePane.locator(`[data-progress-card-placement="${placement}"]`);
          const timestamp = card.locator("time");
          await expect
            .poll(() => timestamp.getAttribute("datetime"))
            .toBe(new Date(updatedAt).toISOString());
          await expect.poll(() => timestamp.getAttribute("aria-label")).toMatch(/^Updated /);
          await expect.poll(() => timestamp.textContent()).toMatch(/^Updated /);
          await expect.poll(() => timestamp.isVisible()).toBe(true);
          const accessibleCard = placement === "composer" ? card.locator("summary") : card;
          await expect
            .poll(() => accessibleCard.getAttribute("aria-label"))
            .not.toContain("Updated");
          const timestampBounds = await timestamp.boundingBox();
          const cardBounds = await card.boundingBox();
          if (!timestampBounds || !cardBounds) {
            throw new Error("The progress card and last activity time must both remain visible");
          }
          expect(timestampBounds.x + timestampBounds.width).toBeLessThanOrEqual(
            cardBounds.x + cardBounds.width,
          );
        };
        await page.setViewportSize({ height: 900, width: 1600 });
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(1);
        const pausedStep = visiblePane.locator(".session-progress-card__step--paused");
        await expect
          .poll(() =>
            visiblePane.locator('[data-progress-card-placement="composer"]').getAttribute("open"),
          )
          .toBe("");
        await page.evaluate(
          ({ gatewayUrl, settingsKey }) => {
            localStorage.setItem(
              settingsKey,
              JSON.stringify({ gatewayUrl, chatCollapseTaskProgress: true }),
            );
          },
          {
            gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
            settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          },
        );
        await page.reload();
        const composerCard = visiblePane.locator('[data-progress-card-placement="composer"]');
        await expect.poll(() => composerCard.getAttribute("open")).toBeNull();
        await expect
          .poll(() => composerCard.locator(".session-progress-card__current").textContent())
          .toBe("Implement");
        await composerCard.locator("summary").click();
        await expect.poll(() => composerCard.getAttribute("open")).toBe("");
        await expect.poll(() => pausedStep.getAttribute("aria-label")).toBe("Implement, paused");
        await expect
          .poll(() => visiblePane.locator(".session-progress-card .session-run-spinner").count())
          .toBe(0);
        await expectVisibleLastActivity("composer");
        await captureProof(page, "composer-attached-wide.png");

        await page.setViewportSize({ height: 900, width: 1280 });
        await openChatSidePanelType(page, "Side chat");
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
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
        await expectVisibleLastActivity("composer");
        await captureProof(page, "composer-with-side-chat.png");

        const sidePanel = visiblePane.locator(".sidebar-region__right-runtime .side-panel");
        await focusChatSidePanel(page);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        await page
          .locator(".chat-pane__header")
          .getByRole("button", { name: "Restore split", exact: true })
          .click();
        await restoreChatAsMain(page);

        await page.setViewportSize({ height: 900, width: 560 });
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        const sideHeader = sidePanel.locator('[data-region-header="side"]');
        await sideHeader.getByRole("button", { name: "Close", exact: true }).click();
        await sideHeader.waitFor({ state: "hidden" });
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').isVisible())
          .toBe(true);
        await expectVisibleLastActivity("composer");
        await captureProof(page, "composer-adjacent.png");
      },
    );
  });

  it("keeps tall markdown-only and mixed progress cards scroll-reachable", async () => {
    const markdown = [
      "| Gate | State |",
      "| --- | --- |",
      ...Array.from(
        { length: 24 },
        (_, index) => `| Gate ${index + 1} | Detailed state for gate ${index + 1} |`,
      ),
    ].join("\n");
    const variants = [
      { name: "markdown-only", steps: undefined },
      {
        name: "markdown-and-plan",
        steps: Array.from({ length: 8 }, (_, index) => ({
          status: index < 3 ? ("completed" as const) : ("pending" as const),
          step: `Plan step ${index + 1}`,
        })),
      },
    ];

    for (const variant of variants) {
      const sessionKey = `agent:main:progress-${variant.name}`;
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 700, width: 980 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
            methodResponses: {
              "progressCard.get": {
                card: {
                  markdown,
                  revision: 1,
                  sessionKey,
                  steps: variant.steps,
                  updatedAt: 1,
                },
              },
              "sessions.list": chatSessionListResponse([
                {
                  key: sessionKey,
                  kind: "direct",
                  label: `Progress ${variant.name}`,
                  updatedAt: 1,
                },
              ]),
            },
            sessionKey,
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
          const card = page.locator('[data-progress-card-placement="composer"]');
          const body = card.locator(".session-progress-card__body");
          await expect.poll(() => card.isVisible()).toBe(true);
          await expect.poll(() => card.getAttribute("open")).toBe("");

          const bodyLayout = await body.evaluate((node) => ({
            clientHeight: node.clientHeight,
            overflowY: getComputedStyle(node).overflowY,
            scrollHeight: node.scrollHeight,
          }));
          expect(bodyLayout.overflowY).toBe("auto");
          expect(bodyLayout.scrollHeight).toBeGreaterThan(bodyLayout.clientHeight);

          if (captureUiProofEnabled && variant.name === "markdown-only") {
            const parentStyle = await page.addStyleTag({
              content: `.session-progress-card--composer .session-progress-card__body {
                overflow: hidden !important;
                overscroll-behavior: auto !important;
                scrollbar-width: auto !important;
              }`,
            });
            expect(await body.evaluate((node) => getComputedStyle(node).overflowY)).toBe("hidden");
            await captureProof(page, "tall-markdown-before-clipped.png");
            await parentStyle.evaluate((node) => node.parentNode?.removeChild(node));
          }

          const lastMarkdownRow = card.locator("tbody tr:last-child");
          await lastMarkdownRow.scrollIntoViewIfNeeded();
          await expectInsideProgressBody(lastMarkdownRow);
          expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          expect(await page.evaluate(() => window.scrollY)).toBe(0);
          await captureProof(page, `tall-${variant.name}-after-scrolled.png`);

          if (variant.steps) {
            const lastStep = card.locator(".session-progress-card__step:last-child");
            await lastStep.scrollIntoViewIfNeeded();
            await expectInsideProgressBody(lastStep);
            expect(
              await card
                .locator(".session-progress-card__steps")
                .evaluate((node) => node.clientHeight),
            ).toBeGreaterThan(0);
            expect(await page.evaluate(() => window.scrollY)).toBe(0);
            await captureProof(page, `tall-${variant.name}-final-step.png`);
          }
        },
      );
    }
  });

  it("presents completed disclosure states and dismisses the card across reload", async () => {
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
          const composerFade = await page
            .locator(".agent-chat__composer-shell")
            .evaluate((node) => getComputedStyle(node, "::before").backgroundImage);
          expect(composerFade).toBe("none");
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
          await expect
            .poll(() => card.locator(".session-progress-card__summary-title").isVisible())
            .toBe(true);
          await expect
            .poll(() => card.locator(".session-progress-card__current-marker").isVisible())
            .toBe(false);
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
