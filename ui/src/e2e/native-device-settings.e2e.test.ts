import path from "node:path";
import type { Page } from "playwright";
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
  nativeDeviceSettingsReplies?: Array<(snapshot: NativeDeviceSettingsSnapshot) => void>;
};

async function installDeviceSettingsBridge(page: Page, snapshot: NativeDeviceSettingsSnapshot) {
  await installNativeWebChrome(page);
  await page.addInitScript((initial: NativeDeviceSettingsSnapshot) => {
    const messages: unknown[] = [];
    const replies: Array<(snapshot: NativeDeviceSettingsSnapshot) => void> = [];
    const nativeWindow = window as DeviceSettingsTestWindow;
    Object.assign(nativeWindow, {
      __OPENCLAW_NATIVE_DEVICE_SETTINGS__: initial,
      nativeDeviceSettingsMessages: messages,
      nativeDeviceSettingsReplies: replies,
    });
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          openclawDeviceSettings: {
            postMessage(message: unknown) {
              messages.push(message);
              if (
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "set"
              ) {
                return new Promise<NativeDeviceSettingsSnapshot>((resolve) => {
                  replies.push(resolve);
                });
              }
              return Promise.resolve(nativeWindow["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"]);
            },
          },
        },
      },
    });
  }, snapshot);
}

async function replyToDeviceSetting(page: Page, snapshot: NativeDeviceSettingsSnapshot) {
  await page.evaluate((next: NativeDeviceSettingsSnapshot) => {
    const nativeWindow = window as DeviceSettingsTestWindow;
    const reply = nativeWindow.nativeDeviceSettingsReplies?.shift();
    if (!reply) {
      throw new Error("No native settings request is waiting for a reply");
    }
    nativeWindow["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"] = next;
    reply(next);
  }, snapshot);
}

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
        await installDeviceSettingsBridge(page, snapshot);
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

        const iconStyle = devicePage.getByRole("combobox", { name: "Dock icon", exact: true });
        await expect.poll(() => iconStyle.inputValue()).toBe("paper");
        expect(await iconStyle.locator("option").allTextContents()).toEqual(
          ["Original", "Heritage", "Clawmark", "Origami", "Pincer", "Open C"].map((name) =>
            expect.stringContaining(name),
          ),
        );
        await iconStyle.selectOption("origami");
        await expect
          .poll(messages)
          .toContainEqual({ type: "set", key: "app.iconStyle", value: "origami" });
        snapshot.app.iconStyle!.selectedId = "origami";

        await devicePage
          .locator(".settings-row__title")
          .filter({ hasText: /^Show Dock icon$/ })
          .click();
        await expect
          .poll(messages)
          .toContainEqual({ type: "set", key: "app.showDockIcon", value: false });
        snapshot.app.showDockIcon = false;
        snapshot.app.quickChatShortcut = "⌘⇧Space";
        await replyToDeviceSetting(page, snapshot);
        await replyToDeviceSetting(page, snapshot);
        await devicePage.getByText("⌘⇧Space", { exact: true }).waitFor();
        await expect.poll(() => dockIcon.isChecked()).toBe(false);
        await expect.poll(() => iconStyle.inputValue()).toBe("origami");
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

  it("settles canceled cookie edits and preserves newer drafts across native replies and navigation", async () => {
    const artifactDir = createControlUiE2eArtifactDir("native-cookie-consent");
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
        snapshot.browser.cookieSync.enabled = true;
        snapshot.browser.cookieSync.state = "idle";
        await installDeviceSettingsBridge(page, snapshot);
        await installMockGateway(page, { operatorScopes: ["operator.read"] });
        await page.goto(`${suite.server.baseUrl}settings/device`);
        const devicePage = page.locator("openclaw-device-page");
        const sidebar = page.locator(".settings-sidebar");
        const profile = devicePage.getByRole("textbox", { name: "Target profile", exact: true });
        const messages = () =>
          page.evaluate(() => (window as DeviceSettingsTestWindow).nativeDeviceSettingsMessages);
        const revisit = async () => {
          await sidebar.locator('a[href="/settings/device/permissions"]').click();
          await page.locator("openclaw-device-permissions-page").waitFor();
          await sidebar.locator('a[href="/settings/device"]').click();
          await profile.waitFor();
        };
        const addDomain = async (domain: string) => {
          await devicePage.getByRole("textbox", { name: "Add hostname", exact: true }).fill(domain);
          await devicePage.getByRole("button", { name: "Add hostname", exact: true }).click();
        };
        const expectProfileRequest = async (value: string) => {
          await expect
            .poll(messages)
            .toContainEqual({ type: "set", key: "browser.cookieSync.targetProfile", value });
        };

        await addDomain("cancelled.example.com");
        await expect.poll(messages).toContainEqual({
          type: "set",
          key: "browser.cookieSync.domains",
          value: ["example.com", "cancelled.example.com"],
        });
        await revisit();
        const cancelledDomain = devicePage.getByRole("button", {
          name: "Remove cancelled.example.com",
          exact: true,
        });
        await cancelledDomain.waitFor();
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "01-pending-cookie-consent.png"),
        });
        // Cancel returns the native owner's unchanged snapshot, without a matching-value ACK.
        await replyToDeviceSetting(page, snapshot);
        await expect.poll(() => cancelledDomain.count()).toBe(0);

        await addDomain("approved.example.com");
        await expect.poll(messages).toContainEqual({
          type: "set",
          key: "browser.cookieSync.domains",
          value: ["example.com", "approved.example.com"],
        });
        snapshot.browser.cookieSync.domains.push("approved.example.com");
        await replyToDeviceSetting(page, snapshot);

        await profile.fill("cancelled-profile");
        await revisit();
        await expectProfileRequest("cancelled-profile");
        await expect.poll(() => profile.inputValue()).toBe("cancelled-profile");
        await replyToDeviceSetting(page, snapshot);
        await expect.poll(() => profile.inputValue()).toBe("default");
        await expect.poll(() => cancelledDomain.count()).toBe(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "02-cancelled-cookie-consent.png"),
        });

        await profile.fill("first-profile");
        await profile.press("Tab");
        await expectProfileRequest("first-profile");
        await profile.fill("second-profile");
        await revisit();
        await expectProfileRequest("second-profile");
        await replyToDeviceSetting(page, snapshot);
        await expect.poll(() => profile.inputValue()).toBe("second-profile");
        snapshot.browser.cookieSync.targetProfile = "second-profile";
        await replyToDeviceSetting(page, snapshot);
        await expect.poll(() => profile.inputValue()).toBe("second-profile");
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "03-confirmed-newer-draft.png"),
        });

        // An external update must be visible once the latest request has settled.
        snapshot.browser.cookieSync.targetProfile = "external-profile";
        await page.evaluate((next: NativeDeviceSettingsSnapshot) => {
          (window as DeviceSettingsTestWindow)["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"] = next;
          window.dispatchEvent(
            new CustomEvent("openclaw:native-device-settings-changed", { detail: next }),
          );
        }, snapshot);
        await expect.poll(() => profile.inputValue()).toBe("external-profile");
      },
    );
  });
});
