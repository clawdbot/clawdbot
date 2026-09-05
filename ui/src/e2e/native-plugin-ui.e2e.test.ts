import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  dockChatSidePanel,
  focusChatSidePanel,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin UI ownership" });
const pluginId = "ui-fixture";
type NativePluginWindow = Window & {
  nativePluginProof?: { release?: () => void };
  nativeActionProof?: {
    runs: number;
    current?: {
      signal: AbortSignal;
      release: () => void;
      withdraw: () => void;
      done: boolean;
      outcome: string;
    };
  };
};

function catalog(revision: string) {
  return {
    revision,
    diagnostics: [],
    plugins: [
      {
        pluginId,
        name: "UI fixture",
        revision,
        entryUrl: `/__openclaw__/plugins/control-ui/${pluginId}/${revision}/index.js`,
        styles: [],
      },
    ],
  };
}

function pluginModule(revision: string) {
  return `export default {
    id: "ui-fixture",
    async activate(host) {
      const proof = globalThis.nativePluginProof ??= {};
      const previous = proof.host;
      if (${JSON.stringify(revision)} === "broken") throw new Error("Fixture activation failed");
      if (${JSON.stringify(revision)} === "pending") {
        await host.request("fixture.activationStarted");
        await new Promise(resolve => { proof.release = resolve; });
        await host.request("fixture.staleInitializer");
      }
      proof.host = host;
      host.ui.registerPage({id:"proof", label:"UI fixture", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Fixture revision ${revision}";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Fixture outcome");
        const button = (label, action) => { const element = document.createElement("button"); element.textContent = label; element.onclick = async () => { try { await action(); output.textContent = "completed"; } catch(error) { output.textContent = error.message; } }; return element; };
        container.append(title, output,
          button("Call current activation", () => context.host.request("fixture.current")),
          button("Unregister composer", () => unregisterComposer()),
          button("Register composer", () => { unregisterComposer = registerComposer(); }),
          button("Unregister retired composer", () => firstUnregisterComposer()),
          button("Call retired composer", () => proof.composer.setDraft("retired draft")),
          button("Call previous activation", () => previous.request("fixture.stale")),
          button("Release pending initializer", () => { proof.release(); throw new Error("released"); }));
      }});
      host.ui.registerNavigation({id:"proof", label:"UI fixture", page:{id:"proof"}});
      host.ui.registerAccessory({id:"session", placement:"session-header", mount(container, context) {
        const output = document.createElement("output"); output.dataset.fixtureSessionAccessory = "";
        const update = next => { output.textContent = next.props.sessionKey; output.dataset.presented = String(next.presented); output.hidden = !next.presented; };
        container.append(output); update(context);
        return { update };
      }});
      host.ui.registerWidget({id:"card", label:"Fixture widget", mount(container) {
        const content = document.createElement("p"); content.textContent = "Fixture widget ${revision}";
        container.append(content);
      }});
      const composer = {id:"composer", label:"Fixture composer", surface:"composer", mount(container, context) {
        let current = context;
        proof.composer = context.props;
        const input = document.createElement("textarea"); input.setAttribute("aria-label", "Fixture draft"); input.value = current.props.draft;
        input.oninput = () => current.props.setDraft(input.value);
        const send = document.createElement("button"); send.textContent = "Fixture send";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Send outcome");
        send.onclick = async () => { try { const result = await current.props.send(); output.textContent = result === true ? "accepted" : result === false ? "rejected" : "completed"; } catch(error) { output.textContent = error.message; } };
        container.append(input, send, output);
        return { update(next) { current = next; input.value = next.props.draft; }, focus() { input.focus(); } };
      }};
      const registerComposer = () => host.ui.registerReplacement(composer);
      let unregisterComposer = registerComposer();
      const firstUnregisterComposer = unregisterComposer;
      host.ui.registerReplacement({id:"delegated-composer", label:"Delegated composer", surface:"composer", mount(container, context) {
        return {dispose: context.mountDefault(container)};
      }});
      host.ui.registerReplacement({id:"failing-composer", label:"Failing composer", surface:"composer", mount() { throw new Error("Fixture composer failed"); }});
      host.ui.registerReplacement({id:"workspace", label:"Fixture workspace", surface:"workspace", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Custom workspace";
        const recover = document.createElement("button"); recover.textContent = "Show built-in workspace";
        recover.onclick = () => context.host.ui.selectReplacement("workspace", null);
        container.append(title, recover);
      }});
      host.ui.registerReplacement({id:"failing-transcript", label:"Failing transcript", surface:"transcript", mount() { throw new Error("Fixture transcript failed"); }});
      if (["withdrawn", "invalid-selection"].includes(${JSON.stringify(revision)})) {
        if (${JSON.stringify(revision)} === "invalid-selection") {
          host.ui.selectReplacement("workspace", "workspace");
        }
        const replacement = {id:"staged-composer", label:"Staged composer", surface:"composer", mount() {}};
        const withdraw = host.ui.registerReplacement(replacement);
        host.ui.selectReplacement("composer", replacement.id);
        if (${JSON.stringify(revision)} === "withdrawn") withdraw();
        else replacement.surface = "transcript";
      }
      return () => { proof.disposed = (proof.disposed ?? 0) + 1; };
    }
  };`;
}

const hungPluginModule = `export default { id:"hung-ui", async activate(host) {
  await host.request("fixture.peerStarted");
  await new Promise(resolve => { globalThis.nativePluginProof.release = resolve; });
  await host.request("fixture.latePeer");
} };`;

const actionPluginModule = `export default { id:"ui-fixture", activate(host) {
  const proof = globalThis.nativeActionProof = { runs: 0 };
  for (const placement of ["header", "composer", "session"]) {
    let unregister;
    const action = {
      id: placement, label: "Hold " + placement + " action", placement,
      async run(context) {
        const invocation = { signal: context.signal, done: false, outcome: "pending" };
        const gate = new Promise(resolve => { invocation.release = resolve; });
        invocation.withdraw = () => {
          unregister();
          unregister = host.ui.registerAction(action);
        };
        proof.current = invocation;
        proof.runs += 1;
        try {
          await gate;
          await context.host.request("fixture.actionContinuation", { placement });
          invocation.outcome = "completed";
        } catch (error) {
          invocation.outcome = error.message;
        } finally {
          invocation.done = true;
        }
      },
    };
    unregister = host.ui.registerAction(action);
  }
} };`;

async function selectView(page: Page, label: string, value: string) {
  await openCustomizeUi(page);
  await page.getByRole("combobox", { name: label, exact: true }).selectOption(value);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

async function openCustomizeUi(page: Page) {
  await page.locator("button.plugin-ui-recovery").evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
}

suite.define(() => {
  it("retires withdrawn action registrations without reviving pending invocations on reuse", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:held-action";
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("actions"),
            "plugins.controlUi.report": { ok: true },
            "fixture.actionContinuation": { ok: true },
            "sessions.list": {
              ts: 1,
              count: 1,
              defaults: {},
              sessions: [
                {
                  key: sessionKey,
                  kind: "direct",
                  agentId: "main",
                  label: "Held action",
                  updatedAt: 1,
                },
              ],
            },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: actionPluginModule }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        let runs = 0;
        const start = async (placement: "header" | "composer" | "session") => {
          if (placement === "session") {
            await page
              .locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`)
              .click({ button: "right" });
            await page
              .locator("openclaw-session-menu")
              .getByRole("menuitem", { name: "Hold session action", exact: true })
              .click();
          } else {
            await page
              .getByRole("button", { name: `Hold ${placement} action`, exact: true })
              .click();
          }
          runs += 1;
          await page.waitForFunction(
            (expected) => (window as NativePluginWindow).nativeActionProof?.runs === expected,
            runs,
          );
        };
        const finish = async () => {
          await page.waitForFunction(
            () => (window as NativePluginWindow).nativeActionProof?.current?.done === true,
          );
          return page.evaluate(
            () => (window as NativePluginWindow).nativeActionProof?.current?.outcome,
          );
        };
        const retired = [];
        for (const placement of ["header", "composer", "session"] as const) {
          await start(placement);
          const before = (await gateway.getRequests("fixture.actionContinuation")).length;
          const abortedBeforeResume = await page.evaluate(() => {
            const invocation = (window as NativePluginWindow).nativeActionProof?.current;
            if (!invocation) {
              throw new Error("Expected a running plugin action.");
            }
            invocation.withdraw();
            const aborted = invocation.signal.aborted;
            invocation.release();
            return aborted;
          });
          const outcome = await finish();
          const after = (await gateway.getRequests("fixture.actionContinuation")).length;
          retired.push({ placement, abortedBeforeResume, outcome, requests: after - before });

          await start(placement);
          await page.evaluate(() => {
            const invocation = (window as NativePluginWindow).nativeActionProof?.current;
            if (!invocation) {
              throw new Error("Expected the replacement action to run.");
            }
            invocation.release();
          });
          expect(await finish()).toBe("completed");
          expect(await gateway.getRequests("fixture.actionContinuation")).toHaveLength(after + 1);
        }
        expect(retired).toEqual(
          ["header", "composer", "session"].map((placement) => ({
            placement,
            abortedBeforeResume: true,
            outcome: "This plugin UI view has ended.",
            requests: 0,
          })),
        );
      },
    );
  });

  it("recovers native widgets from initialization failure and retains healthy reloads", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const sessionKey = "agent:main:native-widget";
        const gateway = await installMockGateway(page, {
          sessionKey,
          heldMethods: ["fixture.activationStarted"],
          controlUiWidgetKinds: [{ pluginId, kind: `${pluginId}:card`, label: "Fixture widget" }],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "board.get",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("pending"),
            "plugins.controlUi.report": { ok: true },
            "board.get": {
              sessionKey,
              revision: 1,
              tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
              widgets: [
                {
                  name: "native-card",
                  tabId: "main",
                  title: "Native card",
                  contentKind: "plugin",
                  pluginKind: `${pluginId}:card`,
                  sizeW: 6,
                  sizeH: 4,
                  position: 0,
                  grantState: "none",
                  revision: 1,
                },
              ],
            },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) => {
          const revision = new URL(route.request().url()).pathname.split("/").at(-2)!;
          return route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: pluginModule(revision),
          });
        });
        const cell = page.locator('[data-widget-name="native-card"]');
        const loading = cell.getByText("Loading plugin widget…", { exact: true });
        const disabled = cell.locator('[data-test-id="board-disabled-plugin"]');
        const error = cell.locator('[data-test-id="board-widget-error"]');
        const expectHealthy = async (revision: string) => {
          await cell.getByText(`Fixture widget ${revision}`, { exact: true }).waitFor();
          expect(await loading.count()).toBe(0);
          expect(await disabled.count()).toBe(0);
          expect(await error.count()).toBe(0);
        };
        const reload = async (revision: string) => {
          await gateway.setMethodResponse("plugins.controlUi.list", catalog(revision));
          await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision });
        };

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        await gateway.waitForRequest("fixture.activationStarted");
        await cell.locator(".board-widget__body").waitFor();
        expect(await loading.count()).toBe(1);
        expect(await disabled.count()).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "widget-loading.png") });

        await gateway.rejectDeferred("fixture.activationStarted", {
          message: "Widget initialization failed",
        });
        await error.waitFor();
        expect(await error.locator("code").textContent()).toContain("Widget initialization failed");
        expect(await loading.count()).toBe(0);
        expect(await disabled.count()).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "widget-failed.png") });
        await gateway.setMethodResponse("plugins.controlUi.list", catalog("one"));
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await expectHealthy("one");

        const started = (await gateway.getRequests("fixture.activationStarted")).length;
        await gateway.deferNext("fixture.activationStarted");
        await reload("pending");
        await gateway.waitForRequest("fixture.activationStarted", { after: started });
        await expectHealthy("one");
        const reports = (await gateway.getRequests("plugins.controlUi.report")).length;
        await gateway.rejectDeferred("fixture.activationStarted", {
          message: "Widget reload failed",
        });
        const failed = await gateway.waitForRequest("plugins.controlUi.report", { after: reports });
        expect(failed.params).toMatchObject({ pluginId, revision: "pending", status: "failed" });
        await expectHealthy("one");

        await reload("two");
        await expectHealthy("two");
        expect(await cell.getByText("Fixture widget one", { exact: true }).count()).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "widget-reloaded.png") });
        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "empty",
          plugins: [],
          diagnostics: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "empty" });
        await disabled.waitFor();
        expect(await cell.getByText("Fixture widget two", { exact: true }).count()).toBe(0);
        expect(
          await disabled.getByRole("button", { name: "Delete", exact: true }).isEnabled(),
        ).toBe(true);
        await page.screenshot({ path: path.join(suite.artifactDir, "widget-removed.png") });

        const listed = (await gateway.getRequests("plugins.controlUi.list")).length;
        await gateway.deferNext("plugins.controlUi.list");
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "retry" });
        await gateway.waitForRequest("plugins.controlUi.list", { after: listed });
        await loading.waitFor();
        await gateway.rejectDeferred("plugins.controlUi.list", {
          message: "Widget catalog temporarily unavailable",
        });
        await error.waitFor();
        expect(await error.locator("code").textContent()).toContain(
          "Widget catalog temporarily unavailable",
        );
        expect(await disabled.count()).toBe(0);
        await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await expectHealthy("two");
      },
    );
  });

  it("shows loading through first activation and opens the page while another plugin is pending", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const initial = catalog("pending");
        initial.plugins.unshift({
          pluginId: "hung-ui",
          name: "Hung fixture",
          revision: "pending",
          entryUrl: "/__openclaw__/plugins/control-ui/hung-ui/pending/index.js",
          styles: [],
        });
        const gateway = await installMockGateway(page, {
          heldMethods: ["plugins.controlUi.list", "fixture.peerStarted"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": initial,
            "plugins.controlUi.report": { ok: true },
          },
        });
        const bootstrapRequested = createDeferred();
        const bootstrapGate = createDeferred();
        // Startup and activation can share this request, so hold it before navigation.
        await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
          bootstrapRequested.resolve();
          await bootstrapGate.promise;
          await route.fallback();
        });
        await page.route("**/__openclaw__/plugins/control-ui/*/*/index.js", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: route.request().url().includes("/hung-ui/")
              ? hungPluginModule
              : pluginModule("pending"),
          }),
        );
        const pluginPage = page.locator("openclaw-plugin-page");
        const expectLoading = async () => {
          await pluginPage.getByRole("status", { name: "Loading…", exact: true }).waitFor();
          expect(
            await pluginPage.getByText("Plugin panel unavailable", { exact: true }).count(),
          ).toBe(0);
        };
        try {
          await page.goto(`${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`, {
            waitUntil: "domcontentloaded",
          });
          await gateway.waitForRequest("plugins.controlUi.list");
          await expectLoading();
          expect(
            await page.evaluate(() => ({
              contributions: Boolean(customElements.get("openclaw-plugin-contributions")),
              manager: Boolean(customElements.get("openclaw-plugin-manager")),
            })),
          ).toEqual({ contributions: false, manager: true });
          expect(
            await page
              .locator("openclaw-plugin-contributions")
              .first()
              .evaluate((element) => getComputedStyle(element).display),
          ).toBe("contents");
          await gateway.resolveDeferred("plugins.controlUi.list");
          await bootstrapRequested.promise;
          await expectLoading();
          bootstrapGate.resolve();
          await gateway.waitForRequest("fixture.activationStarted");
          await gateway.waitForRequest("fixture.peerStarted");
          await page.waitForFunction(
            () => typeof (window as NativePluginWindow).nativePluginProof?.release === "function",
          );
          await expectLoading();
          await page.screenshot({ path: path.join(suite.artifactDir, "startup-loading.png") });
          await page.evaluate(() => {
            const release = (window as NativePluginWindow).nativePluginProof?.release;
            if (!release) {
              throw new Error("The fixture initializer has not started.");
            }
            release();
          });
          await page.getByRole("heading", { name: "Fixture revision pending" }).waitFor();
          await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
          expect(
            await pluginPage.getByRole("status", { name: "Loading…", exact: true }).count(),
          ).toBe(0);
          await page.getByRole("button", { name: "Call current activation" }).click();
          await gateway.waitForRequest("fixture.current");
          await expect
            .poll(() => page.getByLabel("Fixture outcome").textContent())
            .toBe("completed");
          const activation = await gateway.waitForRequest("plugins.controlUi.report");
          expect(activation.params).toMatchObject({ pluginId, status: "activated" });
          await page.screenshot({ path: path.join(suite.artifactDir, "startup-ready.png") });
        } finally {
          bootstrapGate.resolve();
        }
      },
    );
  });

  it("loads without asset grants for auth:none and preserves canonical chat admission and view recovery", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const otherSessionKey = "agent:main:accessory-peer";
        const boardSnapshot = {
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          pluginAssetsRequireAuth: false,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "board.get",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
            "sessions.list": {
              ts: 1,
              count: 2,
              defaults: {},
              sessions: [sessionKey, otherSessionKey].map((key) => ({
                key,
                kind: "direct",
                label: key,
                updatedAt: 1,
              })),
            },
            "board.get": {
              cases: [
                { match: { sessionKey }, response: boardSnapshot },
                {
                  match: { sessionKey: otherSessionKey },
                  response: { sessionKey: otherSessionKey, revision: 1, tabs: [], widgets: [] },
                },
              ],
            },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: pluginModule("one") }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
        const accessories = page.locator("[data-fixture-session-accessory]");
        const accessory = accessories.filter({ hasText: sessionKey });
        const expectOneAccessory = async (key = sessionKey) => {
          await expect
            .poll(() => page.locator("[data-fixture-session-accessory]:visible").allTextContents())
            .toEqual([key]);
          expect(await accessories.filter({ hasText: key }).count()).toBe(1);
        };
        await expectOneAccessory();
        await gateway.waitForRequest("board.get");
        await gateway.emitGatewayEvent("board.command", {
          sessionKey,
          command: { kind: "focus_tab", tabId: "main" },
        });
        await page.locator(".board-session-surface:not([hidden])").waitFor();
        await expectOneAccessory();
        for (const dock of ["bottom", "right"] as const) {
          await dockChatSidePanel(page, dock);
          await expect
            .poll(() => page.locator(".sidebar-region--bottom").count())
            .toBe(dock === "bottom" ? 1 : 0);
          await expectOneAccessory();
        }
        await focusChatSidePanel(page);
        await expectOneAccessory();
        await page.getByRole("button", { name: "Restore split", exact: true }).click();
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
        await restoreChatAsMain(page);
        await expectOneAccessory();
        await page.locator('[data-region-header="side"] .side-panel__minimize').click();
        await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
        await expectOneAccessory();
        await page.screenshot({ path: path.join(suite.artifactDir, "before.png"), fullPage: true });
        expect(await page.locator("button.plugin-ui-recovery").isVisible()).toBe(false);
        for (const replacement of [
          "",
          "ui-fixture/delegated-composer",
          "ui-fixture/failing-composer",
        ]) {
          await selectView(page, "Composer", replacement);
          const composer = page.locator(".agent-chat__composer-shell");
          await composer.waitFor();
          expect(
            await composer.evaluate((element) =>
              Boolean(element.closest("openclaw-plugin-view[data-plugin-composer]")),
            ),
          ).toBe(replacement !== "");
          if (replacement === "ui-fixture/failing-composer") {
            await page.getByRole("alert").filter({ hasText: "Fixture composer failed" }).waitFor();
          }
          for (const width of [1280, 640]) {
            await page.setViewportSize({ width, height: 900 });
            const fade = await composer.evaluate((element) => {
              const thread = element
                .closest(".chat-main__conversation")
                ?.querySelector(".chat-thread");
              if (!thread) {
                throw new Error("Expected the built-in conversation beside its composer.");
              }
              const shellBounds = element.getBoundingClientRect();
              const threadBounds = thread.getBoundingClientRect();
              const style = getComputedStyle(element, "::before");
              return {
                content: style.content,
                background: style.backgroundImage,
                left: shellBounds.left + Number.parseFloat(style.left) - threadBounds.left,
                right: threadBounds.right - (shellBounds.right - Number.parseFloat(style.right)),
                scrollbar: Number.parseFloat(
                  getComputedStyle(document.documentElement).getPropertyValue("--scrollbar-size"),
                ),
              };
            });
            const description = `${replacement || "Built-in"} at ${width}px`;
            expect.soft(fade.content, description).toBe('""');
            expect.soft(fade.background, description).toContain("linear-gradient");
            expect.soft(fade.left, description).toBeGreaterThanOrEqual(fade.scrollbar);
            expect.soft(fade.right, description).toBeGreaterThanOrEqual(fade.scrollbar);
          }
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        await selectView(page, "Composer", "ui-fixture/composer");
        await page
          .getByLabel("Fixture draft", { exact: true })
          .fill("Send through the canonical composer");
        await openCustomizeUi(page);
        const composerSelect = page.getByRole("combobox", { name: "Composer", exact: true });
        expect(await composerSelect.inputValue()).toBe("ui-fixture/composer");
        await composerSelect.selectOption("");
        await page.getByRole("button", { name: "Close", exact: true }).last().click();
        await expect
          .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue())
          .toBe("Send through the canonical composer");
        expect(await page.getByLabel("Fixture draft", { exact: true }).count()).toBe(0);
        await selectView(page, "Composer", "ui-fixture/composer");
        expect(await page.getByLabel("Fixture draft", { exact: true }).inputValue()).toBe(
          "Send through the canonical composer",
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, "composer-input.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Fixture send", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          message: "Send through the canonical composer",
          sessionKey: "agent:main:main",
        });
        await expect.poll(() => page.getByLabel("Send outcome").textContent()).toBe("accepted");
        await page.screenshot({
          path: path.join(suite.artifactDir, "composer-sent.png"),
          fullPage: true,
        });
        await selectView(page, "Transcript", "ui-fixture/failing-transcript");
        const transcriptError = page
          .getByRole("alert")
          .filter({ hasText: "Fixture transcript failed" });
        await transcriptError
          .getByRole("button", { name: "Retry plugin view", exact: true })
          .waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "transcript-recovery.png"),
          fullPage: true,
        });
        await selectView(page, "Workspace", "ui-fixture/workspace");
        await page.getByRole("heading", { name: "Custom workspace" }).waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "custom-workspace.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Customize UI", exact: true }).click();
        await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption("");
        await page.getByRole("button", { name: "Close", exact: true }).last().click();
        await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
        await page.getByRole("link", { name: "UI fixture", exact: true }).click();
        await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
        await page.getByRole("button", { name: "Call retired composer" }).click();
        await expect
          .poll(() => page.getByLabel("Fixture outcome").textContent())
          .toContain("view has ended");
        await page.screenshot({ path: path.join(suite.artifactDir, "after.png"), fullPage: true });
        await page.locator(".nav-item--home").click();
        await expectOneAccessory();
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherSessionKey}"] a`)
          .click();
        await expectOneAccessory(otherSessionKey);
        await expect.poll(() => accessory.getAttribute("data-presented")).toBe("false");
        expect(await accessory.isVisible()).toBe(false);
        await page.locator(".nav-item--home").click();
        await expectOneAccessory();
        expect(await accessory.getAttribute("data-presented")).toBe("true");
        await page.screenshot({
          path: path.join(suite.artifactDir, "session-accessory-returned.png"),
          fullPage: true,
        });
      },
    );
  });

  it("commits reloads atomically and revokes pending or retired activations", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["plugins.controlUi.report"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
            "plugins.controlUi.reload",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
            "plugins.controlUi.reload": catalog("two"),
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) => {
          const revision = new URL(route.request().url()).pathname.split("/").at(-2)!;
          return route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: pluginModule(revision),
          });
        });
        await page.goto(`${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`);
        const activation = await gateway.waitForRequest("plugins.controlUi.report");
        expect(activation.params).toMatchObject({ pluginId, revision: "one", status: "activated" });
        await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
        await gateway.waitForRequest("plugins.controlUi.report");
        const listed = (await gateway.getRequests("plugins.controlUi.list")).length;
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "one" });
        await gateway.waitForRequest("plugins.controlUi.list", { after: listed });
        await page.getByRole("button", { name: "Call current activation" }).click();
        await expect.poll(() => page.getByLabel("Fixture outcome").textContent()).toBe("completed");
        expect(await gateway.getRequests("fixture.current")).toHaveLength(1);
        await gateway.resolveDeferred("plugins.controlUi.report", { ok: true });
        const reload = async (revision: string) => {
          await gateway.setMethodResponse("plugins.controlUi.list", catalog(revision));
          await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision });
        };
        const readComposerSelection = async () => {
          await openCustomizeUi(page);
          const selected = await page
            .getByRole("combobox", { name: "Composer", exact: true })
            .inputValue();
          await page.getByRole("button", { name: "Close", exact: true }).last().click();
          return selected;
        };
        await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
        await openCustomizeUi(page);
        await page.getByRole("button", { name: "Reload plugin UI", exact: true }).click();
        await gateway.waitForRequest("plugins.controlUi.reload");
        await page.getByRole("button", { name: "Close", exact: true }).last().click();
        await page.getByRole("heading", { name: "Fixture revision two" }).waitFor();
        expect(await page.getByRole("heading", { name: "Fixture revision one" }).count()).toBe(0);
        await page.getByRole("button", { name: "Call previous activation" }).click();
        await expect
          .poll(() => page.getByLabel("Fixture outcome").textContent())
          .toContain("activation has ended");
        expect(await gateway.getRequests("fixture.stale")).toHaveLength(0);
        await selectView(page, "Composer", "ui-fixture/composer");
        const sameRevisionListed = (await gateway.getRequests("plugins.controlUi.list")).length;
        await openCustomizeUi(page);
        const reloadButton = page.getByRole("button", { name: "Reload plugin UI", exact: true });
        await reloadButton.click();
        await gateway.waitForRequest("plugins.controlUi.list", { after: sameRevisionListed });
        await expect.poll(() => reloadButton.isEnabled()).toBe(true);
        expect(
          await page.getByRole("combobox", { name: "Composer", exact: true }).inputValue(),
        ).toBe("ui-fixture/composer");
        await page.getByRole("button", { name: "Close", exact: true }).last().click();
        await reload("broken");
        await expect
          .poll(async () =>
            (await gateway.getRequests("plugins.controlUi.report")).some(
              (request) => (request.params as { status: string }).status === "failed",
            ),
          )
          .toBe(true);
        await page.getByRole("heading", { name: "Fixture revision two" }).waitFor();
        expect(await readComposerSelection()).toBe("ui-fixture/composer");
        await selectView(page, "Composer", "");
        const revisions = [
          ["withdrawn", "activated"],
          ["invalid-selection", "failed"],
          // A rejected revision must remain retryable.
          ["invalid-selection", "failed"],
        ] as const;
        for (const [attempt, [revision, status]] of revisions.entries()) {
          const reported = (await gateway.getRequests("plugins.controlUi.report")).length;
          await reload(revision);
          const receipt = await gateway.waitForRequest("plugins.controlUi.report", {
            after: reported,
          });
          expect(receipt.params).toMatchObject({ pluginId, revision, status });
          await page.getByRole("heading", { name: "Fixture revision withdrawn" }).waitFor();
          const calls = (await gateway.getRequests("fixture.current")).length;
          await page.getByRole("button", { name: "Call current activation" }).click();
          await gateway.waitForRequest("fixture.current", { after: calls });
          await expect
            .poll(() => page.getByLabel("Fixture outcome").textContent())
            .toBe("completed");
          await openCustomizeUi(page);
          for (const surface of ["Composer", "Workspace"]) {
            expect(
              await page.getByRole("combobox", { name: surface, exact: true }).inputValue(),
            ).toBe("");
          }
          if (status === "failed") {
            const { error } = receipt.params as { error: string };
            expect(error).toEqual(expect.stringMatching(/\S/));
            await page
              .getByRole("alert")
              .filter({ hasText: pluginId })
              .filter({ hasText: error })
              .waitFor();
          }
          await page.screenshot({
            path: path.join(suite.artifactDir, `selection-${attempt + 1}-${revision}.png`),
            fullPage: true,
          });
          await page.getByRole("button", { name: "Close", exact: true }).last().click();
        }
        await reload("pending");
        await gateway.waitForRequest("fixture.activationStarted");
        await reload("three");
        await page.getByRole("heading", { name: "Fixture revision three" }).waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "reloaded.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Release pending initializer" }).click();
        await expect.poll(() => page.getByLabel("Fixture outcome").textContent()).toBe("released");
        expect(await gateway.getRequests("fixture.staleInitializer")).toHaveLength(0);
        const retiredSelections: Record<string, string> = {};
        await selectView(page, "Composer", "ui-fixture/composer");
        await page.getByRole("button", { name: "Unregister composer", exact: true }).click();
        await expect.poll(() => page.getByLabel("Fixture outcome").textContent()).toBe("completed");
        await page.getByRole("button", { name: "Register composer", exact: true }).click();
        retiredSelections.registration = await readComposerSelection();
        await selectView(page, "Composer", "ui-fixture/composer");
        await page
          .getByRole("button", { name: "Unregister retired composer", exact: true })
          .click();
        await expect.poll(() => page.getByLabel("Fixture outcome").textContent()).toBe("completed");
        expect(await readComposerSelection()).toBe("ui-fixture/composer");
        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "empty",
          plugins: [],
          diagnostics: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "empty" });
        await page.getByText("Plugin panel unavailable", { exact: true }).waitFor();
        expect(await page.getByRole("link", { name: "UI fixture", exact: true }).count()).toBe(0);
        await reload("three");
        await page.getByRole("heading", { name: "Fixture revision three" }).waitFor();
        retiredSelections.removal = await readComposerSelection();
        await selectView(page, "Composer", "ui-fixture/composer");
        const connected = (await gateway.getRequests("connect")).length;
        const reported = (await gateway.getRequests("plugins.controlUi.report")).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest();
        await gateway.waitForRequest("connect", { after: connected });
        for (const collapsed of [false, true]) {
          if (collapsed) {
            await page.locator(".sidebar-brand__collapse").click();
          }
          const chrome = page.locator(
            collapsed ? ".shell-chrome-controls" : ".sidebar-brand__actions",
          );
          await expect
            .poll(async () => {
              const banner = await page.locator(".connection-action-block").boundingBox();
              const controls = await chrome.boundingBox();
              if (!banner || !controls) {
                throw new Error("The reconnect banner and shell controls must be visible.");
              }
              // Expanded controls occupy the sidebar; collapsed controls share the content column.
              return collapsed
                ? banner.y - (controls.y + controls.height)
                : banner.x - (controls.x + controls.width);
            })
            .toBeGreaterThanOrEqual(0);
        }
        await page.locator(".shell-chrome-controls__nav-toggle").click();
        const pluginPage = page.locator("openclaw-plugin-page");
        await pluginPage.getByRole("status", { name: "Loading…", exact: true }).waitFor();
        expect(
          await pluginPage.getByText("Plugin panel unavailable", { exact: true }).count(),
        ).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "reconnecting.png") });
        await gateway.resolveDeferred("connect");
        const reconnected = await gateway.waitForRequest("plugins.controlUi.report", {
          after: reported,
        });
        expect(reconnected.params).toMatchObject({
          pluginId,
          revision: "three",
          status: "activated",
        });
        await page.getByRole("heading", { name: "Fixture revision three" }).waitFor();
        retiredSelections.connection = await readComposerSelection();
        expect(retiredSelections).toEqual({ registration: "", removal: "", connection: "" });
      },
    );
  });

  it("activates healthy peers while a hung initializer times out and releases the reload control", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
            "plugins.controlUi.reload",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/*/*/index.js", (route) => {
          const segments = new URL(route.request().url()).pathname.split("/");
          const body =
            segments.at(-3) === "hung-ui" ? hungPluginModule : pluginModule(segments.at(-2)!);
          return route.fulfill({ status: 200, contentType: "text/javascript", body });
        });
        await page.goto(`${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`);
        const activation = await gateway.waitForRequest("plugins.controlUi.report");
        expect(activation.params).toMatchObject({ pluginId, revision: "one", status: "activated" });
        await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
        await page.clock.install();
        const next = catalog("two");
        next.plugins.unshift({
          pluginId: "hung-ui",
          name: "Hung fixture",
          revision: "pending",
          entryUrl: "/__openclaw__/plugins/control-ui/hung-ui/pending/index.js",
          styles: [],
        });
        await gateway.setMethodResponse("plugins.controlUi.list", next);
        await gateway.setMethodResponse("plugins.controlUi.reload", next);
        await openCustomizeUi(page);
        const reload = page.getByRole("button", { name: "Reload plugin UI", exact: true });
        await reload.click();
        await gateway.waitForRequest("fixture.peerStarted");
        await page.getByRole("heading", { name: "Fixture revision two" }).waitFor();
        expect(await reload.isDisabled()).toBe(true);
        await page.clock.fastForward(15_000);
        await page
          .getByText("Plugin UI initialization timed out. Check the plugin and reload its UI.", {
            exact: false,
          })
          .waitFor();
        await expect.poll(() => reload.isEnabled()).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, "peer-timeout-recovery.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Close", exact: true }).last().click();
        await page.getByRole("button", { name: "Release pending initializer" }).click();
        await expect.poll(() => page.getByLabel("Fixture outcome").textContent()).toBe("released");
        expect(await gateway.getRequests("fixture.latePeer")).toHaveLength(0);
        expect(
          (await gateway.getRequests("plugins.controlUi.report")).map((request) => request.params),
        ).toContainEqual(expect.objectContaining({ pluginId: "hung-ui", status: "failed" }));
      },
    );
  });
});
