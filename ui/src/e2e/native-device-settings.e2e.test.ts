import path from "node:path";
import { expect, it } from "vitest";
import type { NativeDeviceSettingsSnapshot } from "../app/native-device-settings.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createNativeDeviceSettingsSnapshot } from "../test-helpers/native-device-settings.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

type DeviceSettingsTestWindow = Window & {
  __OPENCLAW_NATIVE_DEVICE_SETTINGS__?: NativeDeviceSettingsSnapshot;
  nativeDeviceSettingsMessages?: unknown[];
};

const suite = createControlUiE2eSuite({
  name: "Control UI native device settings E2E",
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("edits this Mac without Gateway admin scope and hides device settings in browsers", async () => {
    const artifactDir = createControlUiE2eArtifactDir("native-device-settings");
    const viewport = { width: 1440, height: 1800 };
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        recordVideo: { dir: artifactDir, size: viewport },
      },
      async ({ page }) => {
        const snapshot = createNativeDeviceSettingsSnapshot();
        await installNativeWebChrome(page);
        await page.addInitScript((initial: NativeDeviceSettingsSnapshot) => {
          const messages: unknown[] = [];
          Object.assign(window, {
            __OPENCLAW_NATIVE_DEVICE_SETTINGS__: initial,
            nativeDeviceSettingsMessages: messages,
          });
          Object.defineProperty(window, "webkit", {
            configurable: true,
            value: {
              messageHandlers: {
                openclawDeviceSettings: {
                  postMessage(message: unknown) {
                    messages.push(message);
                  },
                },
              },
            },
          });
        }, snapshot);
        await installMockGateway(page, { operatorScopes: ["operator.read"] });
        expect((await page.goto(`${suite.server.baseUrl}settings/device`))?.status()).toBe(200);

        const sidebar = page.locator(".settings-sidebar");
        await sidebar
          .locator(".settings-sidebar__group-label")
          .filter({ hasText: /^\s*This Mac\s*$/ })
          .waitFor();
        await sidebar.locator('a[href="/settings/device"]').waitFor();
        const devicePage = page.locator("openclaw-device-page");
        const dockIcon = devicePage.getByRole("switch", { name: "Show Dock icon", exact: true });
        await expect.poll(() => dockIcon.isChecked()).toBe(true);
        expect(await dockIcon.isDisabled()).toBe(false);
        const messages = () =>
          page.evaluate(() => (window as DeviceSettingsTestWindow).nativeDeviceSettingsMessages);
        await expect.poll(messages).toContainEqual({ type: "status" });

        await devicePage
          .locator(".settings-row__title")
          .filter({ hasText: /^Show Dock icon$/ })
          .click();
        await expect
          .poll(messages)
          .toContainEqual({ type: "set", key: "app.showDockIcon", value: false });
        snapshot.app.showDockIcon = false;
        snapshot.app.quickChatShortcut = "⌘⇧Space";
        await page.evaluate((next: NativeDeviceSettingsSnapshot) => {
          (window as DeviceSettingsTestWindow)["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"] = next;
          window.dispatchEvent(
            new CustomEvent("openclaw:native-device-settings-changed", { detail: next }),
          );
        }, snapshot);
        await devicePage.getByText("⌘⇧Space", { exact: true }).waitFor();
        await expect.poll(() => dockIcon.isChecked()).toBe(false);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "01-this-mac.png"),
        });

        await sidebar.locator('a[href="/settings/device/permissions"]').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/device/permissions");
        const permissionsPage = page.locator("openclaw-device-permissions-page");
        const notifications = permissionsPage.locator(".settings-row").filter({
          has: page.locator(".settings-row__title").filter({ hasText: /^Notifications$/ }),
        });
        await notifications.getByRole("button", { name: "Grant…", exact: true }).click();
        await expect
          .poll(messages)
          .toContainEqual({ type: "request-permission", id: "notifications" });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "02-permissions.png"),
        });

        await sidebar.locator('a[href="/settings/updates"]').click();
        await page.getByRole("button", { name: "Check for Updates…", exact: true }).click();
        await expect.poll(messages).toContainEqual({ type: "check-for-updates" });
      },
    );

    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["voicewake.get", "voicewake.set"],
          deferredMethods: ["voicewake.set"],
          methodResponses: { "voicewake.get": { triggers: ["openclaw"] } },
        });
        for (const route of ["device", "device/permissions"]) {
          expect((await page.goto(`${suite.server.baseUrl}settings/${route}`))?.status()).toBe(200);
          await page.getByText(/only available inside the OpenClaw Mac app/).waitFor();
          await page.locator('.settings-sidebar__item[href="/settings/devices"]').waitFor();
          expect(
            await page
              .locator(
                '.settings-sidebar__item[href="/settings/device"], .settings-sidebar__item[href="/settings/device/permissions"]',
              )
              .count(),
          ).toBe(0);
          expect(
            await page
              .locator(".settings-sidebar__group-label")
              .filter({ hasText: /^\s*This Mac\s*$/ })
              .count(),
          ).toBe(0);
        }
        await page.goto(`${suite.server.baseUrl}settings/talk`);
        const triggers = page.getByRole("textbox", { name: "Trigger words", exact: true });
        await expect.poll(() => triggers.inputValue()).toBe("openclaw");
        await triggers.fill("first phrase");
        await gateway.waitForRequest("voicewake.set");
        expect(await triggers.isEnabled()).toBe(true);
        expect(await triggers.evaluate((element) => element === document.activeElement)).toBe(true);
        await triggers.fill("second phrase");
        await gateway.deferNext("voicewake.set");
        await gateway.resolveDeferred("voicewake.set", { triggers: ["first phrase"] });
        await expect.poll(() => gateway.getRequests("voicewake.set")).toHaveLength(2);
        expect((await gateway.getRequests("voicewake.set"))[1]?.params).toEqual({
          triggers: ["second phrase"],
        });
        expect(await triggers.inputValue()).toBe("second phrase");
        expect(await triggers.evaluate((element) => element === document.activeElement)).toBe(true);
        await gateway.resolveDeferred("voicewake.set", { triggers: ["second phrase"] });
        await page
          .getByRole("status")
          .filter({ hasText: /^Saved$/ })
          .waitFor();
        expect(await triggers.inputValue()).toBe("second phrase");
      },
    );
  });
});
