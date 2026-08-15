import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar alignment capture",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const outputDir = path.resolve(
  process.cwd(),
  process.env.OPENCLAW_SIDEBAR_CAPTURE_OUTPUT_DIR ?? ".artifacts/control-ui-e2e/sidebar-alignment",
);
const screenshotPath = path.join(outputDir, "sidebar.png");
const baseTime = Date.parse("2026-08-14T12:00:00.000Z");

function session(
  key: string,
  label: string,
  category: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    category,
    status: "done",
    totalTokens: 0,
    updatedAt: baseTime,
    ...overrides,
  };
}

suite.define(() => {
  it("captures the complete sidebar alignment fixture", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            {
              self: true,
              id: "profile-operator",
              name: "Operator",
              watchedSessions: ["agent:main:plain"],
            },
            {
              id: "profile-ada",
              name: "Ada",
              watchedSessions: ["agent:main:owner-present"],
            },
            {
              id: "profile-zoe",
              name: "Zoe",
              watchedSessions: ["agent:main:owner-present"],
            },
          ],
          sessionGroups: ["Research", "Operations"],
          sessionKey: "agent:main:plain",
          methodResponses: {
            "sessions.list": {
              count: 4,
              creators: [
                { id: "profile-ada", label: "Ada" },
                { id: "profile-bob", label: "Bob" },
              ],
              defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
              path: "",
              sessions: [
                session("agent:main:owner-present", "Owner present", "Research", {
                  createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                  updatedAt: baseTime + 4_000,
                }),
                session("agent:main:plain", "No leading artwork", "Research", {
                  updatedAt: baseTime + 3_000,
                }),
                session("agent:main:owner-away", "Owner away", "Operations", {
                  createdActor: { type: "human", id: "profile-bob", label: "Bob" },
                  updatedAt: baseTime + 2_000,
                }),
                session("agent:main:running", "Running session", "Operations", {
                  activeRunIds: ["run-sidebar-capture"],
                  hasActiveRun: true,
                  status: "running",
                  updatedAt: baseTime + 1_000,
                }),
              ],
              ts: baseTime,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);
        const sidebar = page.locator(".sidebar");
        await sidebar.waitFor({ state: "visible" });
        await expect.poll(() => sidebar.locator(".nav-section__items .nav-item").count()).toBe(3);
        await expect
          .poll(() => sidebar.locator('[data-session-section^="category:"]').count())
          .toBe(2);
        await expect.poll(() => sidebar.locator(".sidebar-recent-session").count()).toBe(4);
        await expect
          .poll(() =>
            sidebar
              .locator('[data-session-key="agent:main:owner-present"] .viewer-facepile')
              .getAttribute("data-viewer-count"),
          )
          .toBe("1");
        await expect
          .poll(() =>
            sidebar
              .locator('[data-session-key="agent:main:owner-present"] .session-owner-chip')
              .getAttribute("class"),
          )
          .not.toContain("session-owner-chip--away");
        await expect
          .poll(() =>
            sidebar
              .locator('[data-session-key="agent:main:owner-away"] .session-owner-chip')
              .getAttribute("class"),
          )
          .toContain("session-owner-chip--away");

        const clip = await sidebar.boundingBox();
        if (!clip) {
          throw new Error("Sidebar did not expose a screenshot bounding box");
        }
        await mkdir(outputDir, { recursive: true });
        await page.screenshot({ animations: "disabled", clip, path: screenshotPath });
        process.stdout.write(`Sidebar screenshot: ${screenshotPath}\n`);
      },
    );
  });
});
