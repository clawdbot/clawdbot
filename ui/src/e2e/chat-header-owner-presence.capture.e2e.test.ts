import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat header owner presence capture",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "deduplicates participants watching the %s",
    async (face) => {
      const outputDir = createControlUiE2eArtifactDir(
        "chat-header-owner-presence",
        process.env.OPENCLAW_CHAT_HEADER_CAPTURE_OUTPUT_DIR,
      );
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 760, width: 1180 },
        },
        async ({ page }) => {
          const sessionKey = "agent:main:owner-present";
          const gateway = await installMockGateway(page, {
            hasMultipleSessionSharingIdentities: true,
            presenceUsers: [
              {
                self: true,
                id: "profile-operator",
                identity: { type: "profile", id: "profile-operator" },
                name: "Operator",
              },
              {
                id: "profile-ada",
                identity: { type: "profile", id: "profile-ada" },
                name: "Ada",
                watchedSessions: [sessionKey],
              },
              {
                id: "profile-zoe",
                identity: { type: "profile", id: "profile-zoe" },
                name: "Zoe",
                watchedSessions: [sessionKey],
              },
              {
                id: "profile-lin",
                identity: { type: "profile", id: "profile-lin" },
                name: "Lin",
                watchedSessions: [sessionKey],
              },
            ],
            sessionKey,
            featureMethods: ["board.get"],
            methodResponses: {
              "board.get": {
                sessionKey,
                revision: 1,
                tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
                widgets: [],
              },
              "sessions.list": {
                count: 1,
                owners: [
                  {
                    type: "human",
                    id: "profile-ada",
                    identity: { type: "profile", id: "profile-ada" },
                    label: "Ada",
                  },
                  {
                    type: "human",
                    id: "profile-zoe",
                    identity: { type: "profile", id: "profile-zoe" },
                    label: "Zoe",
                  },
                ],
                defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
                path: "",
                sessions: [
                  {
                    contextTokens: null,
                    createdActor: {
                      type: "human",
                      id: "profile-ada",
                      identity: { type: "profile", id: "profile-ada" },
                      label: "Ada",
                    },
                    owner: {
                      actor: {
                        type: "human",
                        id: "profile-ada",
                        identity: { type: "profile", id: "profile-ada" },
                        label: "Ada",
                      },
                    },
                    participants: [
                      { identity: { type: "profile", id: "profile-zoe" }, label: "Zoe" },
                    ],
                    participantCount: 1,
                    displayName: "Owner presence",
                    hasActiveRun: false,
                    key: sessionKey,
                    kind: "direct",
                    label: "Owner presence",
                    model: "gpt-5.5",
                    modelProvider: "openai",
                    status: "done",
                    totalTokens: 0,
                    updatedAt: Date.parse("2026-08-14T12:00:00.000Z"),
                  },
                ],
                ts: Date.parse("2026-08-14T12:00:00.000Z"),
              },
            },
          });

          const response = await page.goto(
            controlUiSessionUrl(suite.server.baseUrl, sessionKey, face),
          );
          expect(response?.status()).toBe(200);
          const header = page.locator(".chat-pane__header").first();
          await header.waitFor({ state: "visible" });
          await expect.poll(() => header.locator(".session-owner-chip--header").count()).toBe(1);
          await expect
            .poll(() =>
              header.locator('.chat-pane__participants .viewer-avatar[aria-label="Zoe"]').count(),
            )
            .toBe(1);
          await expect.poll(() => header.locator('[data-viewer-id="profile-lin"]').count()).toBe(1);

          const screenshotPath = path.join(outputDir, `${face}-header.png`);
          const clip = await header.boundingBox();
          if (!clip) {
            throw new Error("Chat header did not expose a screenshot bounding box");
          }
          await page.screenshot({ animations: "disabled", clip, path: screenshotPath });
          process.stdout.write(`Chat header screenshot: ${screenshotPath}\n`);

          await expect
            .poll(() =>
              header
                .locator(".chat-pane__presence .viewer-facepile")
                .getAttribute("data-viewer-count"),
            )
            .toBe("1");
          await expect.poll(() => header.locator('[data-viewer-id="profile-ada"]').count()).toBe(0);
          await expect
            .poll(() => header.locator('.viewer-avatar[aria-label="Zoe"]:visible').count())
            .toBe(1);
          await expect
            .poll(() => header.locator(".session-owner-chip--header").getAttribute("class"))
            .not.toContain("session-owner-chip--away");

          await gateway.emitGatewayEvent("presence", { presence: [] });
          await expect.poll(() => header.locator(".chat-pane__presence").count()).toBe(0);
          await expect
            .poll(() => header.locator('.viewer-avatar[aria-label="Zoe"]:visible').count())
            .toBe(1);
        },
      );
    },
  );
});
