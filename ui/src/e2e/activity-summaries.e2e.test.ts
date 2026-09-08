import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Activity summaries mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
type ActivityApp = HTMLElement & { runtime: { context: ApplicationContext } };
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-activity-summaries");
  }
});

suite.define(() => {
  it.each(["return", "first visit"] as const)(
    "retains activity across sessions for a %s and chat changes after diagnostic traffic",
    async (visit) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const otherSessionKey = "agent:main:other";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", displayName: "Main", updatedAt: Date.now() },
            { key: otherSessionKey, kind: "direct", displayName: "Other", updatedAt: Date.now() },
          ],
        });
        const emitTool = (id: string, key: string) =>
          gateway.emitGatewayEvent("session.tool", {
            stream: "tool",
            runId: `run-${id}`,
            sessionKey: key,
            data: {
              phase: "result",
              name: "read",
              toolCallId: id,
              result: { text: `${id} completed while this tab was open.` },
            },
          });
        const fillDiagnosticLog = async () => {
          for (let index = 0; index < 251; index += 1) {
            await gateway.emitGatewayEvent("diagnostic", { index });
          }
        };
        await page.goto(
          `${suite.server.baseUrl}${visit === "return" ? "activity?view=live" : "settings/appearance"}`,
        );
        if (visit === "return") {
          await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
        } else {
          await waitForControlUiSettingsTakeover(page);
        }
        await gateway.waitForRequest("connect");
        await emitTool("original", sessionKey);
        await fillDiagnosticLog();
        if (visit === "return") {
          await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-identity-card").click();
          await sidebar
            .locator("wa-dropdown.sidebar-identity-menu")
            .getByRole("menuitem", { name: "Settings", exact: true })
            .click();
          await waitForControlUiSettingsTakeover(page);
        }
        await page.locator("openclaw-activity-page").waitFor({ state: "detached" });
        await emitTool("while-away", otherSessionKey);
        await fillDiagnosticLog();
        const loggedEvents = await page.evaluate(() => {
          const app = document.querySelector<ActivityApp>("openclaw-app");
          if (!app) {
            throw new Error("Control UI app is unavailable");
          }
          return app.runtime.context.gateway.eventLog.map((event) => event.event);
        });
        expect(loggedEvents).toHaveLength(250);
        expect(loggedEvents).not.toContain("session.tool");

        await page.evaluate(() => {
          const app = document.querySelector<ActivityApp>("openclaw-app");
          if (!app) {
            throw new Error("Control UI app is unavailable");
          }
          app.runtime.context.navigate("activity", { search: "?view=live" });
        });
        await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(2);
        await page.getByRole("button", { name: "Expand all", exact: true }).click();
        for (const id of ["original", "while-away"]) {
          await page
            .locator(".activity-entry__preview", {
              hasText: `${id} completed while this tab was open.`,
            })
            .waitFor({ state: "visible" });
        }

        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${otherSessionKey}"] a.sidebar-recent-session__link`,
          )
          .click();
        await waitForControlUiRoute(page, { routeId: "chat" });
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.querySelector<ActivityApp>("openclaw-app")?.runtime.context.gateway
                  .snapshot.sessionKey,
            ),
          )
          .toBe(otherSessionKey);
        await page.goBack();
        await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(2);
        expect(await gateway.getSocketCount()).toBe(1);
      });
    },
  );

  it("updates one visible tool summary from running to completed output", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { sessionKey: "main" });
        const startedAt = Date.now();

        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await page.getByText("No activity yet.", { exact: true }).waitFor();

        await gateway.emitGatewayEvent("agent", {
          runId: "run-diagnostics",
          seq: 1,
          stream: "tool",
          ts: startedAt,
          sessionKey: "main",
          data: {
            phase: "start",
            name: "web_search",
            toolCallId: "tool-diagnostics",
            args: { query: "operator diagnostics" },
          },
        });

        const entry = page.locator(".activity-entry").filter({ hasText: "web_search" });
        await entry.waitFor();
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
        await entry.getByText("Running", { exact: true }).waitFor();
        await entry
          .locator(".activity-entry__summary .activity-entry__text")
          .getByText("1 argument hidden", { exact: true })
          .waitFor();

        await gateway.emitGatewayEvent("agent", {
          runId: "run-diagnostics",
          seq: 2,
          stream: "tool",
          ts: startedAt + 250,
          sessionKey: "main",
          data: {
            phase: "result",
            name: "web_search",
            toolCallId: "tool-diagnostics",
            result: {
              content: [{ type: "text", text: "Indexed 3 diagnostic sources." }],
            },
          },
        });

        await entry.getByText("Done", { exact: true }).waitFor();
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
        await page.getByText("1 of 1", { exact: true }).waitFor();
        await entry.locator("summary").click();
        await entry.getByText("Indexed 3 diagnostic sources.", { exact: true }).waitFor();
        await entry.getByText("Run: run-diagnostics", { exact: true }).waitFor();

        if (captureUiProof) {
          await writeFile(
            path.join(proofDir, "completed-tool-summary.png"),
            await takeControlUiViewportScreenshot(page, entry, [
              entry.getByText("Indexed 3 diagnostic sources.", { exact: true }),
            ]),
          );
        }
      },
    );
  });
});
