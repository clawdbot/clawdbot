import path from "node:path";
import { expect, it } from "vitest";
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
  it("retries an initial catalog failure and restores recovered models", async () => {
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
            "models.list": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Model catalog temporarily unavailable",
              },
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
        const picker = section.locator("wa-select.model-picker__select");
        await picker.waitFor();
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
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
        const initialOptions = (await picker.locator("wa-option").allTextContents()).map((text) =>
          text.trim(),
        );
        if (captureUiProof) {
          await section.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "01-initial-failure.png"),
          });
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
        await page.clock.runFor(10_000);
        await expect
          .poll(async () => (await gateway.getRequests("system.info")).length)
          .toBe(initialSystemInfoRequestCount + 1);
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
        const finalSystemInfoRequestCount = (await gateway.getRequests("system.info")).length;
        const finalRequestCount = (await gateway.getRequests("models.list")).length;
        const finalWarningVisible = await section
          .getByText("Explicit model catalog unavailable", { exact: true })
          .isVisible()
          .catch(() => false);
        await picker.click();
        await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
        const finalOptions = (await picker.locator("wa-option").allTextContents()).map((text) =>
          text.trim(),
        );
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

        expect(initialWarningVisible).toBe(true);
        expect(initialOptions).toEqual(["Auto (provider default)", "Disabled"]);
        expect(finalSystemInfoRequestCount).toBe(initialSystemInfoRequestCount + 1);
        expect(finalRequestCount).toBe(2);
        expect(finalWarningVisible).toBe(false);
        expect(finalOptions).toEqual([
          "Auto (provider default)",
          "Disabled",
          "Claude Recovered",
          "GPT Recovered",
        ]);

        await picker.getByRole("option", { name: "GPT Recovered", exact: true }).click();
        const patchRequest = await gateway.waitForRequest("config.patch");
        expect(JSON.parse(String((patchRequest.params as { raw?: unknown }).raw))).toEqual({
          agents: { defaults: { utilityModel: "openai/gpt-recovered" } },
        });
      },
    );
  });
});
