import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session Observer model catalog recovery",
  startServerBeforeBrowser: true,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it.each([
    "initial catalog failure",
    "config.changed",
    "chat.metadata.changed",
    "reconnect",
  ] as const)("refreshes the catalog after %s", async (trigger) => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: suite.artifactDir,
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        await page.clock.install();
        const initiallyUnavailable = trigger === "initial catalog failure";
        const config = {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          ui: { prefs: { themeMode: "dark" } },
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "config.patch", "models.list", "system.info"],
          methodResponses: {
            "config.get": {
              config,
              hash: "session-observer-catalog-recovery",
              issues: [],
              raw: JSON.stringify(config),
              runtimeConfig: config,
              valid: true,
            },
            "config.patch": { ok: true },
            "models.list": initiallyUnavailable
              ? {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Model catalog temporarily unavailable",
                  },
                }
              : {
                  models: [
                    { available: true, id: "old-model", name: "Old model", provider: "openai" },
                  ],
                },
          },
        });

        const response = await page.goto(
          `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-sidebar`,
        );
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        const section = page.locator("#settings-appearance-sidebar");
        await section.getByRole("heading", { name: "Session observer" }).waitFor();
        const picker = section.locator("openclaw-select-picker.model-picker__select");
        await picker.waitFor();
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
        if (initiallyUnavailable) {
          await section.getByText("Explicit model catalog unavailable", { exact: true }).waitFor();
        } else {
          await picker
            .locator('[role="option"]')
            .filter({ hasText: "Old model" })
            .waitFor({ state: "attached" });
        }
        await pauseVirtualClock(page);
        const initialSystemInfoRequestCount = (await gateway.getRequests("system.info")).length;
        expect(initialSystemInfoRequestCount).toBeGreaterThan(0);

        const initialRequest = (await gateway.getRequests("models.list"))[0];
        expect(initialRequest?.params).toEqual({
          agentId: "main",
          preparedOnly: true,
          view: "configured",
        });
        const initialWarningVisible = await section
          .getByText("Explicit model catalog unavailable", { exact: true })
          .isVisible()
          .catch(() => false);
        const initialOptions = (
          await picker.locator('[role="option"] .picker-select__label').allTextContents()
        ).map((text) => text.trim());
        if (captureUiProof) {
          // The settings section exceeds the viewport; keep its current field scroll.
          await picker.scrollIntoViewIfNeeded();
          await writeFile(
            path.join(suite.artifactDir, "01-before-refresh.png"),
            await takeControlUiViewportScreenshot(page, section, [picker]),
          );
          await page.evaluate(() => {
            const cue = document.createElement("div");
            cue.id = "session-observer-proof-cue";
            cue.textContent = "Advancing the next 10-second status poll";
            Object.assign(cue.style, {
              background: "#111827",
              border: "1px solid #f9fafb",
              bottom: "16px",
              color: "#f9fafb",
              font: "14px system-ui",
              left: "16px",
              padding: "8px 10px",
              position: "fixed",
              zIndex: "2147483647",
            });
            document.body.append(cue);
          });
        }

        const recoveredModels = [
          {
            available: true,
            id: "gpt-recovered",
            name: "GPT Recovered",
            provider: "openai",
          },
          {
            available: true,
            id: "claude-recovered",
            name: "Claude Recovered",
            provider: "anthropic",
          },
        ];
        await gateway.setMethodResponse("models.list", { models: recoveredModels });
        if (trigger === "reconnect") {
          await gateway.closeLatest(1006, "synthetic transient disconnect");
        } else if (!initiallyUnavailable) {
          await gateway.emitGatewayEvent(trigger, { agentId: "main" });
        }
        await page.clock.runFor(10_000);
        await expect
          .poll(async () => (await gateway.getRequests("system.info")).length)
          .toBe(initialSystemInfoRequestCount + 1);
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
        const finalSystemInfoRequestCount = (await gateway.getRequests("system.info")).length;
        const finalRequestCount = (await gateway.getRequests("models.list")).length;
        expect((await gateway.getRequests("models.list"))[1]?.params).toEqual(
          initialRequest?.params,
        );
        const finalWarningVisible = await section
          .getByText("Explicit model catalog unavailable", { exact: true })
          .isVisible()
          .catch(() => false);
        await picker.locator(".picker-select__trigger").click();
        await expect
          .poll(() => picker.locator(".picker-select__trigger").getAttribute("aria-expanded"))
          .toBe("true");
        const finalOptions = (
          await picker.locator('[role="option"] .picker-select__label').allTextContents()
        ).map((text) => text.trim());
        if (captureUiProof) {
          await page.evaluate((requestCount) => {
            const cue = document.querySelector<HTMLElement>("#session-observer-proof-cue");
            if (cue) {
              cue.textContent = `models.list requests after recovery: ${requestCount}`;
            }
          }, finalRequestCount);
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "02-after-recovery-poll.png"),
          });
        }

        expect(initialWarningVisible).toBe(initiallyUnavailable);
        expect(initialOptions).toEqual([
          "Auto (provider default)",
          "Disabled",
          ...(initiallyUnavailable ? [] : ["Old model"]),
        ]);
        expect(finalSystemInfoRequestCount).toBe(initialSystemInfoRequestCount + 1);
        expect(finalRequestCount).toBe(2);
        expect(finalWarningVisible).toBe(false);
        expect(finalOptions).toEqual([
          "Auto (provider default)",
          "Disabled",
          "Claude Recovered",
          "GPT Recovered",
        ]);

        await picker.locator('[role="option"][data-value="openai/gpt-recovered"]').click();
        const patchRequest = await gateway.waitForRequest("config.patch");
        expect(JSON.parse(String((patchRequest.params as { raw?: unknown }).raw))).toEqual({
          agents: { defaults: { utilityModel: "openai/gpt-recovered" } },
        });
      },
    );
  });
});
