import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "workspace panel startup" });
const panels = [
  { name: "terminal", tag: "openclaw-terminal-panel", selector: ".tp-header" },
  { name: "browser", tag: "openclaw-browser-panel", selector: ".bp" },
  { name: "desktop", tag: "openclaw-desktop-panel", selector: ".bp" },
  { name: "custodian", tag: "openclaw-assistant-panel", selector: ".assistant-panel" },
] as const;

suite.define(() => {
  it.each(panels)(
    "loads only the requested $name panel and restores it on reload",
    async (panel) => {
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          if (panel.name === "terminal") {
            await page.addInitScript(() => {
              const local = window.localStorage;
              const session = window.sessionStorage;
              const readLocal = local.getItem.bind(local);
              const readSession = session.getItem.bind(session);
              Object.defineProperty(Storage.prototype, "getItem", {
                value(this: Storage, key: string) {
                  if (
                    this === local &&
                    /^openclaw\.(terminal|browser|custodian)\.panel\.v1$/.test(key)
                  ) {
                    performance.mark(`panel-layout-read:${key}`);
                  }
                  if (this === local) {
                    return readLocal(key);
                  }
                  if (this === session) {
                    return readSession(key);
                  }
                  throw new TypeError("Illegal storage receiver");
                },
              });
            });
          }
          const scripts = new Set<string>();
          page.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith(".js")) {
              scripts.add(request.url());
            }
          });
          const gateway = await installMockGateway(page, {
            terminalEnabled: true,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "terminal.open",
              "browser.request",
              "desktop.observe",
              "openclaw.chat",
              "openclaw.chat.history",
            ],
            methodResponses: {
              "terminal.list": { sessions: [] },
              "terminal.open": {
                agentId: "main",
                confined: false,
                cwd: "/workspace",
                sessionId: "startup-terminal",
                shell: "/bin/bash",
              },
              "environments.list": { environments: [] },
              "openclaw.chat.history": { turns: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}new`);
          await waitForControlUiGatewayReady(page);
          await page.locator(".new-session-page__message").waitFor();
          await page.waitForLoadState("networkidle");
          const definitions = () =>
            page.evaluate(
              (tags) => tags.filter((tag) => customElements.get(tag)),
              panels.map(({ tag }) => tag),
            );
          expect(await definitions()).toEqual([]);
          if (panel.name === "terminal") {
            const reads = await page.evaluate(() =>
              Object.fromEntries(
                ["terminal", "browser", "custodian"].map((kind) => {
                  const key = `openclaw.${kind}.panel.v1`;
                  return [key, performance.getEntriesByName(`panel-layout-read:${key}`).length];
                }),
              ),
            );
            expect(reads).toEqual({
              "openclaw.terminal.panel.v1": 1,
              "openclaw.browser.panel.v1": 1,
              "openclaw.custodian.panel.v1": 1,
            });
            const sources = (
              await Promise.all(
                [...scripts].map(async (url) => {
                  const response = await page.request.get(`${url}.map`);
                  if (!response.headers()["content-type"]?.includes("json")) {
                    return [];
                  }
                  return ((await response.json()) as { sources: string[] }).sources;
                }),
              )
            ).flat();
            expect(sources.some((source) => source.endsWith("/app/app-host.ts"))).toBe(true);
            expect(
              sources.filter((source) =>
                /components\/(terminal\/terminal-panel\.ts|browser\/browser-panel\.ts|desktop\/desktop-panel\.ts|assistant-panel\.ts)$|pages\/chat\/chat-page\.ts$/.test(
                  source,
                ),
              ),
            ).toEqual([]);
          }
          if (panel.name === "terminal") {
            await page.keyboard.press("Control+Backquote");
          } else if (panel.name === "browser") {
            await gateway.emitGatewayEvent("ui.command", {
              command: { kind: "panel", panel: "browser", open: true },
            });
          } else {
            await page.evaluate(
              (name) =>
                window.dispatchEvent(
                  new CustomEvent(`openclaw:${name}-toggle`, { detail: { open: true } }),
                ),
              panel.name,
            );
          }
          await page.locator(panel.tag).locator(panel.selector).waitFor();
          expect(await definitions()).toEqual([panel.tag]);
          await page.reload();
          await page.locator(panel.tag).locator(panel.selector).waitFor();
          expect(await definitions()).toEqual([panel.tag]);
          if (panel.name === "terminal") {
            const terminal = page.locator(panel.tag).locator(".tp-host");
            await terminal.locator("canvas").waitFor();
            await terminal.click();
            await page.keyboard.type("x");
            await gateway.waitForRequest("terminal.input");
            const inputs = await gateway.getRequests("terminal.input");
            await page.keyboard.press("Control+Backquote");
            await page.locator(panel.tag).locator(panel.selector).waitFor({ state: "hidden" });
            expect(await gateway.getRequests("terminal.input")).toEqual(inputs);
            await page.keyboard.press("Control+Backquote");
            await page.locator(panel.tag).locator(panel.selector).waitFor();
          }
        },
      );
    },
  );
});
