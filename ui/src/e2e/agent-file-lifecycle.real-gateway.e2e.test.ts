// Real Gateway proof for browser agent selection and persisted workspace saves.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import {
  captureAgentFileScreenshot,
  selectAgentFileWorkspace,
} from "./agent-file-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it("reads and saves the selected agent workspace through an isolated Gateway", async (context) => {
    let fixture: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        const server = await gateway;
        await server?.close({ reason: "agent file lifecycle e2e cleanup" });
      },
      release: async () => {
        await fixture?.cleanup();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "control-ui-agent-files",
          layout: "home",
          env: {
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        fixture = state;
        signal.throwIfAborted();
        const mainWorkspace = state.path("workspace-main");
        const writerWorkspace = state.path("workspace-writer");
        // A failed setup must not leave sibling writes running beyond cleanup.
        for (const [workspace, content] of [
          [mainWorkspace, "# Real main instructions\n"],
          [writerWorkspace, "# Real writer instructions\n"],
        ] as const) {
          signal.throwIfAborted();
          await mkdir(workspace, { recursive: true });
          signal.throwIfAborted();
          await writeFile(path.join(workspace, "AGENTS.md"), content, "utf8");
        }
        signal.throwIfAborted();
        await state.writeConfig({
          agents: {
            defaults: { workspace: mainWorkspace },
            entries: {
              main: { default: true, workspace: mainWorkspace },
              writer: { workspace: writerWorkspace },
            },
          },
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
          },
        });
        signal.throwIfAborted();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        signal.throwIfAborted();
        gateway = startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
          },
          async ({ page }) => {
            const url = new URL("settings/agents/main/files", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
            const editor = page.locator(".agent-file-textarea");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");

            await selectAgentFileWorkspace(page, "writer");
            await expect.poll(() => editor.inputValue()).toBe("# Real writer instructions\n");

            await selectAgentFileWorkspace(page, "main");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");
            await editor.fill("# Saved through real Gateway\n");
            const save = page.locator(".agent-file-actions").getByRole("button", { name: "Save" });
            await save.click();
            await expect.poll(() => save.isDisabled()).toBe(true);
            await expect
              .poll(() => readFile(path.join(mainWorkspace, "AGENTS.md"), "utf8"))
              .toBe("# Saved through real Gateway\n");
            await captureAgentFileScreenshot(page, "07-real-gateway-main-save.png");

            const agentsFile = path.join(mainWorkspace, "AGENTS.md");
            const appended = "# Saved through real Gateway\n- agent appended a memory\n";
            await writeFile(agentsFile, appended, "utf8");
            await editor.fill("# Operator draft that never saw the memory\n");
            await save.click();
            const conflict = page.locator(".callout.danger");
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(appended);
            await captureAgentFileScreenshot(page, "08-real-gateway-stale-save-refused.png");

            await save.click();
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(appended);

            await conflict.getByRole("button", { name: "Overwrite" }).click();
            await expect
              .poll(() => readFile(agentsFile, "utf8"))
              .toBe("# Operator draft that never saw the memory\n");
            await expect.poll(() => conflict.isVisible()).toBe(false);

            const secondAppend = "# Operator draft that never saw the memory\n- second memory\n";
            await writeFile(agentsFile, secondAppend, "utf8");
            await editor.fill("# Another operator draft\n");
            await save.click();
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(secondAppend);
            await conflict.getByRole("button", { name: "Reload" }).click();
            await expect.poll(() => editor.inputValue()).toBe(secondAppend);
            expect(await readFile(agentsFile, "utf8")).toBe(secondAppend);
            await captureAgentFileScreenshot(page, "09-real-gateway-conflict-reloaded.png");

            await editor.fill("# Draft typed before the refresh\n");
            const thirdAppend = `${secondAppend}- third memory\n`;
            await writeFile(agentsFile, thirdAppend, "utf8");
            await page
              .locator(".settings-section__header")
              .filter({ hasText: "Core Files" })
              .getByRole("button", { name: "Refresh" })
              .click();
            await expect.poll(() => editor.inputValue()).toBe("# Draft typed before the refresh\n");
            await save.click();
            await expect.poll(() => conflict.isVisible()).toBe(true);
            expect(await readFile(agentsFile, "utf8")).toBe(thirdAppend);
            await captureAgentFileScreenshot(page, "10-real-gateway-refresh-then-save.png");
          },
        );
      },
    });
  });
});
