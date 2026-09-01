import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI accent selection",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("syncs the first accent swatch as a color selection", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const coralAccent = "#ff8066";
        const configResponse = (accent: string, hash: string) => ({
          appliedConfigHash: hash,
          config: { ui: { prefs: { accent } } },
          configRevisionHash: hash,
          hash,
          issues: [],
          raw: JSON.stringify({ ui: { prefs: { accent } } }),
          valid: true,
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(coralAccent, "appearance-first-accent-1"),
            "config.patch": { ok: true },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("config.get");

        const accentSection = page.locator("#settings-appearance-accent");
        const firstSwatch = accentSection.locator(".settings-accent-swatch").first();
        await accentSection.scrollIntoViewIfNeeded();
        await gateway.setMethodResponse(
          "config.get",
          configResponse("#ff5c5c", "appearance-first-accent-2"),
        );
        await firstSwatch.click();
        await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);

        expect(await firstSwatch.getAttribute("data-accent-preset")).toBe("claw");
        const patch = (await gateway.getRequests("config.patch"))[0];
        const raw = String((patch?.params as { raw?: unknown } | undefined)?.raw);
        expect(JSON.parse(raw)).toEqual({ ui: { prefs: { accent: "#ff5c5c" } } });
        await expect.poll(() => firstSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect
          .poll(() =>
            page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            ),
          )
          .toMatchObject({ accent: "#ff5c5c" });

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = createControlUiE2eArtifactDir("appearance-accent-selection");
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "first-accent-selected.png"),
          });
        }
      },
    );
  });
});
