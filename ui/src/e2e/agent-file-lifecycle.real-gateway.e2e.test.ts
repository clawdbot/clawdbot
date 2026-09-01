// Real Gateway proof for browser agent selection and persisted workspace saves.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
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
  it("reads and saves the selected agent workspace through an isolated Gateway", async () => {
    const port = await getFreePort();
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
    let gateway: GatewayServer | undefined;
    try {
      const mainWorkspace = state.path("workspace-main");
      const writerWorkspace = state.path("workspace-writer");
      await Promise.all([
        mkdir(mainWorkspace, { recursive: true }),
        mkdir(writerWorkspace, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(mainWorkspace, "AGENTS.md"), "# Real main instructions\n", "utf8"),
        writeFile(path.join(writerWorkspace, "AGENTS.md"), "# Real writer instructions\n", "utf8"),
      ]);
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
      state.applyEnv();
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

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
        },
      );
    } finally {
      try {
        await gateway?.close({ reason: "agent file lifecycle e2e cleanup" });
      } finally {
        await state.cleanup();
      }
    }
  });
});
