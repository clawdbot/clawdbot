// Control UI tests cover form support for transform-backed config fields.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import type {
  NativeNotificationsMessage,
  NativeNotificationsStatus,
} from "../test-helpers/native-notifications.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI config form guidance mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "config-form-guidance",
);

function notificationStatusConfigMocks() {
  const config = { ui: { prefs: { theme: "claw" } } };
  return {
    "config.get": {
      appliedConfigHash: "notification-status-e2e",
      config,
      configRevisionHash: "notification-status-e2e",
      hash: "notification-status-e2e",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    "config.schema": {
      generatedAt: "2026-07-28T00:00:00.000Z",
      schema: {
        type: "object",
        properties: {
          ui: {
            type: "object",
            title: "UI",
            properties: {
              prefs: {
                type: "object",
                title: "Prefs",
                properties: { theme: { type: "string", title: "Theme" } },
              },
            },
          },
        },
      },
      uiHints: { "ui.prefs.theme": { advanced: false } },
      version: "e2e",
    },
  };
}

const runtimeSuite = createControlUiE2eSuite({
  name: "Control UI notification module recovery",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

type NativeNotificationsFixture = {
  messages: NativeNotificationsMessage[];
  status: NativeNotificationsStatus;
  publish(status: NativeNotificationsStatus): void;
};

declare global {
  interface Window {
    __notificationsFixture?: NativeNotificationsFixture;
    __OPENCLAW_NATIVE_NOTIFICATIONS__?: NativeNotificationsStatus;
  }
}

runtimeSuite.define(() => {
  it.each(["browser", "native"] as const)(
    "disables unavailable %s notification actions and recovers after reloading the runtime",
    async (transport) => {
      await runtimeSuite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1440 },
        },
        async ({ page }) => {
          await installMockGateway(page, {
            methodResponses: notificationStatusConfigMocks(),
          });
          if (transport === "native") {
            await page.addInitScript(() => {
              const status: NativeNotificationsStatus = {
                supported: true,
                permission: "notDetermined",
              };
              window["__OPENCLAW_NATIVE_NOTIFICATIONS__"] = status;
              Object.defineProperty(window, "__OPENCLAW_NATIVE_NOTIFICATIONS_BRIDGE__", {
                value: {
                  postMessage(message: NativeNotificationsMessage) {
                    window.dispatchEvent(
                      new CustomEvent("openclaw:native-notifications-status", {
                        detail: { ...status, replyTo: message.requestId },
                      }),
                    );
                  },
                },
              });
            });
          }
          const runtimeModule =
            transport === "native"
              ? /\/native-notifications\.runtime\.ts(?:\?|$)/u
              : /\/web-push\.runtime\.ts(?:\?|$)/u;
          await page.route(runtimeModule, (route) => route.abort());
          await page.goto(`${runtimeSuite.server.baseUrl}settings/appearance`);
          await page.getByRole("link", { name: "Notifications", exact: true }).click();
          const section = page.locator("#settings-communications-notifications");
          await section.locator(".cfg-field__error").waitFor();
          if (captureUiProofEnabled) {
            await mkdir(uiProofArtifactDir, { recursive: true });
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(
                uiProofArtifactDir,
                `06-${transport}-notifications-runtime-unavailable.png`,
              ),
            });
          }
          await expect.poll(() => section.getByRole("button").count()).toBe(0);
          expect(await section.locator(".cfg-field__error").textContent()).toContain("Reload");

          await page.unroute(runtimeModule);
          await page.reload();
          await expect.poll(() => section.locator(".cfg-field__error").count()).toBe(0);
          await section
            .getByRole("button", { name: "Enable notifications", exact: true })
            .waitFor();
          await expect
            .poll(() => section.locator(".settings-section__header").textContent())
            .toContain(transport === "native" ? "Not requested" : "Ready");
        },
      );
    },
  );

  it.each(["webkit", "tauri"] as const)(
    "uses shared native preferences and correlated replies without Web Push (%s)",
    async (transport) => {
      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
      }
      await runtimeSuite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1100, width: 1440 },
          recordVideo: captureUiProofEnabled
            ? { dir: uiProofArtifactDir, size: { height: 1100, width: 1440 } }
            : undefined,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: notificationStatusConfigMocks(),
          });
          const webPushModules: string[] = [];
          page.on("request", (request) => {
            if (/\/web-push\.runtime\.ts(?:\?|$)/u.test(request.url())) {
              webPushModules.push(request.url());
            }
          });
          await page.addInitScript((bridgeTransport) => {
            const native = window;
            const user = {
              categories: {
                approvalRequested: true,
                agentFinished: false,
                agentQuestion: false,
                scheduledTaskFailed: false,
                backgroundTaskFailed: false,
              },
              detailLevel: "private" as const,
              quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
              agentIds: [],
            };
            const fixture: NativeNotificationsFixture = {
              messages: [],
              status: {
                supported: true,
                permission: "notDetermined",
                preferences: {
                  user,
                  device: { enabled: false, label: "Desktop" },
                  effective: { ...user, enabled: false, label: "Desktop" },
                  canManageUserPreferences: true,
                  devicePersistence: "profile",
                },
              },
              publish(status) {
                fixture.status = status;
                native["__OPENCLAW_NATIVE_NOTIFICATIONS__"] = status;
                window.dispatchEvent(
                  new CustomEvent("openclaw:native-notifications-status", { detail: status }),
                );
              },
            };
            native["__notificationsFixture"] = fixture;
            native["__OPENCLAW_NATIVE_NOTIFICATIONS__"] = fixture.status;
            const poster = {
              postMessage(message: NativeNotificationsMessage) {
                fixture.messages.push(message);
                if (message.type === "status" || message.type === "preferences-get") {
                  fixture.publish({ ...fixture.status, replyTo: message.requestId });
                }
              },
            };
            Object.defineProperty(
              window,
              bridgeTransport === "webkit" ? "webkit" : "__OPENCLAW_NATIVE_NOTIFICATIONS_BRIDGE__",
              {
                configurable: true,
                value:
                  bridgeTransport === "webkit"
                    ? { messageHandlers: { openclawNotifications: poster } }
                    : poster,
              },
            );
          }, transport);
          await page.goto(`${runtimeSuite.server.baseUrl}settings/appearance`);
          await page.getByRole("link", { name: "Notifications", exact: true }).click();
          const section = page.locator("#settings-communications-notifications");
          const enable = section.getByRole("button", { name: "Enable notifications", exact: true });
          await enable.waitFor();
          if (captureUiProofEnabled) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(uiProofArtifactDir, `07-native-${transport}-account-preferences.png`),
            });
          }
          expect(
            await page.evaluate(() =>
              window["__notificationsFixture"]?.messages.every(
                ({ type }) => type === "status" || type === "preferences-get",
              ),
            ),
          ).toBe(true);
          await enable.click();
          await expect.poll(() => enable.isDisabled()).toBe(true);
          await page.evaluate(() => {
            const fixture = window["__notificationsFixture"];
            if (!fixture) {
              throw new Error("Native notification fixture is not installed");
            }
            fixture.publish({
              ...fixture.status,
              permission: "granted",
              replyTo: "unrelated-status",
            });
          });
          await expect.poll(() => enable.isDisabled()).toBe(true);
          await page.evaluate(() => {
            const fixture = window["__notificationsFixture"];
            if (!fixture) {
              throw new Error("Native notification fixture is not installed");
            }
            const request = fixture.messages.findLast(({ type }) => type === "request-permission")!;
            fixture.publish({ ...fixture.status, replyTo: request.requestId });
          });
          const enabledDevice = await page.evaluate(() =>
            window["__notificationsFixture"]?.messages.findLast(
              ({ type }) => type === "preferences-set",
            ),
          );
          expect(enabledDevice).toMatchObject({
            type: "preferences-set",
            scope: "device",
            preferences: { enabled: true, label: "Desktop" },
          });
          await expect.poll(() => enable.isDisabled()).toBe(true);
          await page.evaluate(() => {
            const fixture = window["__notificationsFixture"];
            if (!fixture) {
              throw new Error("Native notification fixture is not installed");
            }
            const request = fixture.messages.findLast(({ type }) => type === "preferences-set")!;
            const preferences = fixture.status.preferences!;
            fixture.publish({
              ...fixture.status,
              replyTo: request.requestId,
              preferences: {
                ...preferences,
                device: { ...preferences.device, enabled: true },
                effective: { ...preferences.effective, enabled: true },
              },
            });
          });
          const sendTest = section.getByRole("button", { name: "Send test", exact: true });
          await expect.poll(() => sendTest.isEnabled()).toBe(true);
          const account = page
            .locator("section.settings-section")
            .filter({ has: page.getByRole("heading", { name: "Account defaults", exact: true }) });
          await account
            .locator(".settings-row")
            .filter({ hasText: "Agent finished" })
            .getByRole("checkbox")
            .check();
          const save = await page.evaluate(() =>
            window["__notificationsFixture"]?.messages.findLast(
              ({ type }) => type === "preferences-set",
            ),
          );
          expect(save).toMatchObject({
            type: "preferences-set",
            scope: "user",
            preferences: { categories: { agentFinished: true } },
          });
          expect(Object.keys(save!).toSorted()).toEqual([
            "preferences",
            "requestId",
            "scope",
            "type",
          ]);
          await expect.poll(() => account.locator("..").getAttribute("inert")).not.toBeNull();
          await page.evaluate(() => {
            const fixture = window["__notificationsFixture"];
            if (!fixture) {
              throw new Error("Native notification fixture is not installed");
            }
            const request = fixture.messages.findLast(({ type }) => type === "preferences-set")!;
            fixture.publish({
              ...fixture.status,
              replyTo: request.requestId,
              preferences: {
                ...fixture.status.preferences!,
                canManageUserPreferences: false,
                devicePersistence: "session",
              },
            });
          });
          await page
            .getByText(
              "These device settings apply only to this Gateway connection and reset on reconnect.",
              { exact: false },
            )
            .waitFor();
          await expect.poll(() => account.count()).toBe(0);
          await page.getByRole("heading", { name: "This browser or app", exact: true }).waitFor();
          if (captureUiProofEnabled) {
            await mkdir(uiProofArtifactDir, { recursive: true });
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(uiProofArtifactDir, `07-native-${transport}-session-preferences.png`),
            });
          }
          await page.evaluate(() => {
            const fixture = window["__notificationsFixture"];
            if (!fixture) {
              throw new Error("Native notification fixture is not installed");
            }
            fixture.publish({
              supported: false,
              permission: "granted",
              error: "Update this Gateway to use native notification preferences.",
            });
          });
          await section
            .getByText("Update this Gateway to use native notification preferences.", {
              exact: true,
            })
            .waitFor();
          expect(await section.getByRole("button").count()).toBe(0);
          expect(
            await page.getByRole("heading", { name: "This browser or app", exact: true }).count(),
          ).toBe(0);
          if (captureUiProofEnabled) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(uiProofArtifactDir, `08-native-${transport}-gateway-unavailable.png`),
            });
          }
          expect(webPushModules).toEqual([]);
          expect(await gateway.getRequests("push.web.subscribe")).toEqual([]);
          expect(await gateway.getRequests("push.web.vapidPublicKey")).toEqual([]);
        },
      );
    },
  );
});

suite.define(() => {
  it("renders every accepted branch of a transform input schema", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = { meta: { groupPolicy: "allowlist" } };
        await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              hash: "config-form-guidance-e2e",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "config.schema": {
              generatedAt: "2026-07-14T00:00:00.000Z",
              schema: {
                type: "object",
                properties: {
                  meta: {
                    type: "object",
                    title: "Meta",
                    properties: {
                      groupPolicy: {
                        title: "Group policy",
                        anyOf: [
                          { type: "string", enum: ["open", "allowlist", "disabled"] },
                          { type: "string", const: "allowall" },
                        ],
                      },
                    },
                  },
                },
              },
              uiHints: {},
              version: "e2e",
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/advanced`);
        expect(response?.status()).toBe(200);

        await page.getByRole("button", { name: "Core" }).click();
        await page.getByRole("button", { name: "Meta", exact: true }).click();

        const policyRow = page.locator(".settings-row").filter({ hasText: "Group policy" });
        await expect.poll(() => policyRow.locator("wa-radio").count()).toBe(4);
        await expect.poll(() => policyRow.getByText("open", { exact: true }).count()).toBe(1);
        await expect.poll(() => policyRow.getByText("allowlist", { exact: true }).count()).toBe(1);
        await expect.poll(() => policyRow.getByText("disabled", { exact: true }).count()).toBe(1);
        await expect.poll(() => policyRow.getByText("allowall", { exact: true }).count()).toBe(1);
        await expect
          .poll(() => page.getByText("Unsupported schema node. Use Raw mode.").count())
          .toBe(0);
        await expect
          .poll(() => page.locator(".config-content-callout .callout.info").count())
          .toBe(0);

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "01-transform-field-supported.png"),
          });
        }

        await page.getByRole("button", { name: "Raw", exact: true }).click();
        await expect.poll(() => page.locator(".config-raw-field textarea").count()).toBe(1);
        await expect
          .poll(() => page.locator(".config-content-callout .callout.info").count())
          .toBe(0);
      },
    );
  });

  it("keeps the one advanced disclosure browser-local", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = { ui: { prefs: { theme: "claw" } } };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "advanced-disclosure-e2e",
              config,
              configRevisionHash: "advanced-disclosure-e2e",
              hash: "advanced-disclosure-e2e",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "config.schema": {
              generatedAt: "2026-07-27T00:00:00.000Z",
              schema: {
                type: "object",
                properties: {
                  ui: {
                    type: "object",
                    title: "UI",
                    properties: {
                      seamColor: { type: "string", title: "Accent Color" },
                      prefs: {
                        type: "object",
                        title: "Prefs",
                        properties: {
                          theme: { type: "string", title: "Theme" },
                          sidebarEntries: {
                            type: "array",
                            title: "Sidebar Entries",
                            items: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              uiHints: {
                "ui.prefs.theme": { advanced: false },
                "ui.prefs.sidebarEntries": { advanced: true },
                "ui.seamColor": { advanced: true },
              },
              version: "e2e",
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await page.getByRole("tab", { name: "UI", exact: true }).click();

        const disclosure = page.locator("details.config-advanced-disclosure");
        await expect.poll(() => disclosure.count()).toBe(1);
        await expect.poll(() => disclosure.getAttribute("open")).toBeNull();
        await expect
          .poll(() => disclosure.locator(":scope > summary").textContent())
          .toContain("Advanced settings");
        await expect
          .poll(() => page.getByText("Show Advanced Settings", { exact: true }).count())
          .toBe(0);

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "02-advanced-collapsed.png"),
          });
        }

        await disclosure.locator(":scope > summary").click();
        await expect.poll(() => disclosure.getAttribute("open")).not.toBeNull();

        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "03-advanced-expanded.png"),
          });
        }

        await disclosure.locator(":scope > summary").click();
        await expect.poll(() => disclosure.getAttribute("open")).toBeNull();
        await page.waitForTimeout(750);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "04-advanced-collapsed-final.png"),
          });
        }
      },
    );
  });

  it("keeps a settled autosave quiet on Notifications", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: notificationStatusConfigMocks(),
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await page.getByRole("tab", { name: "UI", exact: true }).click();

        const themeInput = page
          .locator(".settings-row")
          .filter({ hasText: "Theme" })
          .locator("input.settings-input");
        await expect.poll(() => themeInput.count()).toBe(1);
        await themeInput.fill("knot");
        await gateway.waitForRequest("config.set");
        await page.getByRole("button", { name: "Apply changes", exact: true }).click();
        await gateway.waitForRequest("config.apply");

        await page.getByRole("link", { name: "Notifications", exact: true }).click();
        await page.getByRole("heading", { name: "Push notifications", exact: true }).waitFor();

        const section = page.locator("#settings-communications-notifications");
        await expect.poll(() => page.locator(".config-toolbar").count()).toBe(0);
        await expect.poll(() => page.getByText("Saved", { exact: true }).count()).toBe(0);
        await expect
          .poll(() => section.locator(".settings-section__header .settings-status").count())
          .toBe(1);
        await expect
          .poll(() => section.locator(".settings-section__header").textContent())
          .toContain("Ready");

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "05-notifications-ready-aligned.png"),
          });
        }
      },
    );
  });
});
