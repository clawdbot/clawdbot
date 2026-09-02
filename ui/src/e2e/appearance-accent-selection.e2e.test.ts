import { spawn } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiSettingsTakeover } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function startMockDevServer() {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  const baseUrl = `http://127.0.0.1:${port}/`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: repoRoot, stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}settings/appearance`)).ok) {
        return {
          baseUrl,
          close: async () => {
            if (child.exitCode === null && child.signalCode === null) {
              const exited = once(child, "exit");
              child.kill("SIGTERM");
              await Promise.race([exited, delay(5_000)]);
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await exited;
              }
            }
          },
        };
      }
    } catch {}
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error("Timed out waiting for control-ui-mock-dev");
}

const suite = createControlUiE2eSuite({
  name: "Control UI accent selection",
  startServer: startMockDevServer,
});

suite.define(() => {
  it("keeps the theme default first and reveals its reset icon only for overrides", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);

        const accentSection = page.locator("#settings-appearance-accent");
        const swatches = accentSection.locator(".settings-accent-swatch");
        const defaultSwatch = accentSection.locator('[data-accent-preset="default"]');
        const coralSwatch = accentSection.locator('[data-accent-preset="coral"]');
        await accentSection.scrollIntoViewIfNeeded();
        expect(await swatches.first().getAttribute("data-accent-preset")).toBe("default");
        await expect.poll(() => defaultSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect
          .poll(() => defaultSwatch.locator(".settings-accent-swatch__reset").count())
          .toBe(0);

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = createControlUiE2eArtifactDir("appearance-accent-selection");
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "theme-default-selected.png"),
          });
        }

        await coralSwatch.click();

        await expect.poll(() => coralSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => defaultSwatch.getAttribute("aria-pressed")).toBe("false");
        await expect
          .poll(() => defaultSwatch.locator(".settings-accent-swatch__reset").count())
          .toBe(1);
        await expect
          .poll(() =>
            page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
            ),
          )
          .toBe("#ff8066");
        await expect
          .poll(() => accentSection.locator("#settings-accent-status").textContent())
          .toContain("Using Coral");
        const gatewayScope = `${suite.server.baseUrl.replace(/^http/u, "ws")}__openclaw_mock_gateway__`;
        await expect
          .poll(() =>
            page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              `openclaw.control.settings.v1:${gatewayScope}`,
            ),
          )
          .toMatchObject({ accent: "#ff8066" });

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = createControlUiE2eArtifactDir("appearance-accent-override");
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "coral-selected-with-reset.png"),
          });
        }

        await defaultSwatch.click();
        await expect.poll(() => defaultSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect
          .poll(() => defaultSwatch.locator(".settings-accent-swatch__reset").count())
          .toBe(0);
        await expect.poll(() => coralSwatch.getAttribute("aria-pressed")).toBe("false");
        await expect
          .poll(() =>
            page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              `openclaw.control.settings.v1:${gatewayScope}`,
            ),
          )
          .not.toHaveProperty("accent");
      },
    );
  });
});
