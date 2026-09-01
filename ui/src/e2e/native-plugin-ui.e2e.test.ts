import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin UI ownership" });
const pluginId = "ui-fixture";

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
          button("Call retired composer", () => proof.composer.setDraft("retired draft")),
          button("Call previous activation", () => previous.request("fixture.stale")),
          button("Release pending initializer", () => { proof.release(); throw new Error("released"); }));
      }});
      host.ui.registerNavigation({id:"proof", label:"UI fixture", page:{id:"proof"}});
      host.ui.registerReplacement({id:"composer", label:"Fixture composer", surface:"composer", mount(container, context) {
        let current = context;
        proof.composer = context.props;
        const input = document.createElement("textarea"); input.setAttribute("aria-label", "Fixture draft"); input.value = current.props.draft;
        input.oninput = () => current.props.setDraft(input.value);
        const send = document.createElement("button"); send.textContent = "Fixture send";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Send outcome");
        send.onclick = async () => { try { const result = await current.props.send(); output.textContent = result === true ? "accepted" : result === false ? "rejected" : "completed"; } catch(error) { output.textContent = error.message; } };
        container.append(input, send, output);
        return { update(next) { current = next; input.value = next.props.draft; }, focus() { input.focus(); } };
      }});
      host.ui.registerReplacement({id:"workspace", label:"Fixture workspace", surface:"workspace", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Custom workspace";
        const recover = document.createElement("button"); recover.textContent = "Show built-in workspace";
        recover.onclick = () => context.host.ui.selectReplacement("workspace", null);
        container.append(title, recover);
      }});
      host.ui.registerReplacement({id:"failing-transcript", label:"Failing transcript", surface:"transcript", mount() { throw new Error("Fixture transcript failed"); }});
      return () => { proof.disposed = (proof.disposed ?? 0) + 1; };
    }
  };`;
}

async function selectView(page: Page, label: string, value: string) {
  await page.getByRole("button", { name: "Customize UI", exact: true }).click();
  await page.getByRole("combobox", { name: label, exact: true }).selectOption(value);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

suite.define(() => {
  it("loads without asset grants for auth:none and preserves canonical chat admission and view recovery", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          pluginAssetsRequireAuth: false,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: pluginModule("one") }),
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "before.png"), fullPage: true });
        await selectView(page, "Composer", "ui-fixture/composer");
        await page
          .getByLabel("Fixture draft", { exact: true })
          .fill("Send through the canonical composer");
        await page.getByRole("button", { name: "Customize UI", exact: true }).click();
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
        await page.getByRole("button", { name: "Customize UI", exact: true }).waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "custom-workspace.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Show built-in workspace" }).click();
        await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
        await page.getByRole("link", { name: "UI fixture", exact: true }).click();
        await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
        await page.getByRole("button", { name: "Call retired composer" }).click();
        await expect
          .poll(() => page.getByLabel("Fixture outcome").textContent())
          .toContain("view has ended");
        await page.screenshot({ path: path.join(suite.artifactDir, "after.png"), fullPage: true });
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
        await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
        await page.getByRole("button", { name: "Customize UI", exact: true }).click();
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
        await reload("broken");
        await expect
          .poll(async () =>
            (await gateway.getRequests("plugins.controlUi.report")).some(
              (request) => (request.params as { status: string }).status === "failed",
            ),
          )
          .toBe(true);
        await page.getByRole("heading", { name: "Fixture revision two" }).waitFor();
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
        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "empty",
          plugins: [],
          diagnostics: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "empty" });
        await page.getByText("Plugin panel unavailable", { exact: true }).waitFor();
        expect(await page.getByRole("link", { name: "UI fixture", exact: true }).count()).toBe(0);
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
            segments.at(-3) === "hung-ui"
              ? `export default { id:"hung-ui", async activate(host) {
              await host.request("fixture.peerStarted");
              await new Promise(resolve => { globalThis.nativePluginProof.release = resolve; });
              await host.request("fixture.latePeer");
            } };`
              : pluginModule(segments.at(-2)!);
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
        await page.getByRole("button", { name: "Customize UI", exact: true }).click();
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
