import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { QUICK_ACTIONS_QUESTION } from "../test-helpers/custodian-quick-actions.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update failure triage E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_700_000_000_000,
  stats: {
    handoffId: "update-triage-attempt",
    mode: "npm",
    reason: "global-install-failed",
    before: { version: "1.0.0" },
    after: { version: "1.0.0" },
    steps: [
      { name: "install", log: { exitCode: 1, stderrTail: "ENOSPC: no space left on device" } },
    ],
  },
};
const SCHEDULE = {
  channel: "stable",
  autoEnabled: true,
  install: { kind: "package" },
  target: { kind: "package", version: "2.0.0" },
} as const;
const DIAGNOSTIC_REPLY =
  "I will inspect disk space and the recorded install failure before proposing a repair.";

async function recordUpdateTraffic(page: Page): Promise<MockGatewayRequest[]> {
  const traffic: MockGatewayRequest[] = [];
  await page.exposeFunction("recordUpdateTraffic", (request: MockGatewayRequest) => {
    traffic.push(request);
  });
  await page.addInitScript(() => {
    // Mock request logs belong to one document; keep the proof across both
    // stale-chunk recovery and the explicit reload that tests non-replay.
    window.addEventListener("DOMContentLoaded", () => {
      const gatewayWindow = window as unknown as {
        openclawControlUiE2eGateway: { requests: MockGatewayRequest[] };
        recordUpdateTraffic: (request: MockGatewayRequest) => Promise<void>;
      };
      const requests = gatewayWindow.openclawControlUiE2eGateway.requests;
      const record = (request: MockGatewayRequest) => {
        if (request.method === "update.run" || request.method === "openclaw.chat") {
          void gatewayWindow.recordUpdateTraffic(request);
        }
      };
      requests.forEach(record);
      const append = requests.push.bind(requests);
      requests.push = (...added) => {
        added.forEach(record);
        return append(...added);
      };
    });
  });
  return traffic;
}

suite.define(() => {
  it.each(["manual", "automatic", "missing triage module"])(
    "takes a %s failure into diagnosis without replaying the update",
    async (source) => {
      const artifactDir = createControlUiE2eArtifactDir(
        `update-triage-${source.replaceAll(" ", "-")}`,
      );
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1_000, width: 1_400 },
          recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_400 } },
        },
        async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          const traffic = await recordUpdateTraffic(page);
          if (source === "missing triage module") {
            // A replaced installation can retire the current document's lazy chunks.
            await page.route(/\/update-triage\.runtime(?:-[\w-]+\.js|\.ts)(?:\?|$)/, (route) =>
              route.abort("failed"),
            );
          }
          const config = { update: { channel: "stable", auto: { enabled: true } } };
          const gateway = await installMockGateway(page, {
            deferredMethods: ["update.run"],
            featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
            updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
            methodResponses: {
              "config.get": {
                config,
                runtimeConfig: config,
                raw: JSON.stringify(config),
                valid: true,
                hash: "triage-config",
                issues: [],
              },
              "update.status": { sentinel: null, schedule: SCHEDULE },
              "openclaw.chat": {
                sequence: [
                  {
                    sessionId: "update-triage-session",
                    reply: "I can help you maintain this Gateway.",
                    action: "none",
                    question: QUICK_ACTIONS_QUESTION,
                  },
                  {
                    sessionId: "update-triage-session",
                    reply: DIAGNOSTIC_REPLY,
                    action: "none",
                  },
                ],
              },
            },
          });
          const questions = () =>
            traffic.filter(
              ({ method, params }) =>
                method === "openclaw.chat" &&
                params !== null &&
                typeof params === "object" &&
                "message" in params,
            );
          const updateRuns = () => traffic.filter(({ method }) => method === "update.run");
          expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
          await gateway.waitForRequest("update.status");
          await page.getByRole("button", { name: "Update now", exact: true }).waitFor();
          if (source === "automatic") {
            const now = Date.now();
            await gateway.emitGatewayEvent("update.available", {
              schedule: {
                ...SCHEDULE,
                campaign: {
                  id: "automatic-triage",
                  state: "applying",
                  announcedAtMs: now - 60_000,
                  forceAtMs: now + 900_000,
                  updatedAtMs: now,
                },
              },
            });
            await page.getByText("Applying update…", { exact: true }).waitFor();
          } else {
            await page.getByRole("button", { name: "Update now", exact: true }).click();
            await page
              .locator("openclaw-modal-dialog")
              .getByRole("button", { name: "Update and restart", exact: true })
              .click();
            await gateway.waitForRequest("update.run");
          }
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "01-before-failure.png"),
          });
          await gateway.setMethodResponse("update.status", {
            sentinel: FAILURE,
            schedule: SCHEDULE,
          });
          const replacementDocument =
            source === "missing triage module" ? page.waitForEvent("domcontentloaded") : null;
          if (source === "automatic") {
            await gateway.emitGatewayEvent("update.available", { schedule: SCHEDULE });
          } else {
            await gateway.resolveDeferred("update.run", {
              ok: false,
              result: { status: "error", reason: FAILURE.stats.reason },
              sentinel: { payload: FAILURE },
            });
          }
          if (source === "missing triage module") {
            // The existing reachable-document recovery reloads once. The final
            // page must retain the cause and host-side guidance if the chunk is still absent.
            await replacementDocument;
            await gateway.waitForRequest("update.status");
            const status = page.locator("#config-section-update .settings-status");
            await status.getByText("openclaw triage", { exact: false }).waitFor();
            expect(await status.textContent()).toContain("ENOSPC");
            expect(questions()).toHaveLength(0);
            expect(await page.locator(".custodian__alert-card").count()).toBe(0);
          } else {
            const panel = page.locator("openclaw-assistant-panel");
            await panel
              .locator(".custodian__alert-card")
              .getByText("Diagnose failed update", { exact: true })
              .waitFor();
            await expect.poll(questions).toHaveLength(1);
            const question = questions()[0]?.params;
            expect(question).toMatchObject({ message: expect.stringContaining("ENOSPC") });
            expect(question).toMatchObject({
              message: expect.stringContaining("Do not retry the update"),
            });
            expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
            await panel.getByText(DIAGNOSTIC_REPLY, { exact: true }).waitFor();
            expect(await panel.getByText(DIAGNOSTIC_REPLY, { exact: true }).count()).toBe(1);
          }
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "02-triage-outcome.png"),
          });
          await expect.poll(updateRuns).toHaveLength(source === "automatic" ? 0 : 1);
          if (source !== "missing triage module") {
            // The retained failure remains reviewable, while the consumed
            // receipt prevents reopening diagnosis or sending another turn.
            await page.reload();
            await gateway.waitForRequest("update.status");
            const status = page.locator("#config-section-update .settings-status");
            await status.getByText("openclaw triage", { exact: false }).waitFor();
            expect(await status.textContent()).toContain("ENOSPC");
            expect(await page.locator(".custodian__alert-card").count()).toBe(0);
            expect(await page.locator("openclaw-assistant-panel .assistant-panel").count()).toBe(0);
            expect(questions()).toHaveLength(1);
            expect(updateRuns()).toHaveLength(source === "automatic" ? 0 : 1);
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, "03-reloaded-without-replay.png"),
            });
          }
          expect(errors).toEqual([]);
        },
      );
    },
  );

  it.each(["denied", "full"] as const)(
    "keeps failure guidance without automatic diagnosis when session storage is %s",
    async (storageFailure) => {
      const artifactDir = createControlUiE2eArtifactDir(`update-triage-storage-${storageFailure}`);
      await suite.withPage(
        {
          viewport: { height: 1_000, width: 1_400 },
          recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_400 } },
        },
        async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          const traffic = await recordUpdateTraffic(page);
          await page.addInitScript((failure) => {
            if (failure === "denied") {
              Object.defineProperty(window, "sessionStorage", {
                get: () => {
                  throw new DOMException("Storage denied", "SecurityError");
                },
              });
            } else {
              const session = window.sessionStorage;
              const setItem: unknown = Object.getOwnPropertyDescriptor(
                Storage.prototype,
                "setItem",
              )?.value;
              if (typeof setItem !== "function") {
                throw new Error("Storage.setItem is unavailable");
              }
              Storage.prototype.setItem = function (key, value) {
                if (this === session) {
                  throw new DOMException("Storage full", "QuotaExceededError");
                }
                Reflect.apply(setItem, this, [key, value]);
              };
            }
          }, storageFailure);
          // The server retains the failure independently of denied browser storage.
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
            methodResponses: {
              "update.status": { sentinel: FAILURE, schedule: SCHEDULE },
              "openclaw.chat": {
                sessionId: "storage-failure-session",
                reply: "Ready to help.",
                action: "none",
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/updates`);
          for (let load = 0; load < 2; load += 1) {
            if (load > 0) {
              await page.reload();
            }
            await gateway.waitForRequest("update.status");
            const panel = page.locator("openclaw-assistant-panel");
            await panel.getByText("Ready to help.", { exact: true }).first().waitFor();
            const card = panel.locator(".custodian__alert-card");
            await card.getByText("openclaw triage", { exact: false }).waitFor();
            expect(await card.textContent()).toContain("ENOSPC");
            await expectRequestCountStable(gateway, "openclaw.chat", 1);
            expect(
              traffic.filter(
                ({ method, params }) =>
                  method === "openclaw.chat" &&
                  params &&
                  typeof params === "object" &&
                  "message" in params,
              ),
            ).toHaveLength(0);
            expect(traffic.filter(({ method }) => method === "update.run")).toHaveLength(0);
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, `0${load + 1}-failure-guidance.png`),
            });
          }
          expect(errors).toEqual([]);
        },
      );
    },
  );
});
