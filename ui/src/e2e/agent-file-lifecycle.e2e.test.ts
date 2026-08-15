// Control UI E2E tests cover visible agent-file save outcomes and agent ownership.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "agent-file-lifecycle");

async function capture(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

async function selectAgent(page: Page, name: string) {
  const select = page.locator(".agents-control-select openclaw-agent-select");
  await select.locator(".agent-select__trigger").click();
  await select.locator("wa-dropdown-item[data-agent-option]").filter({ hasText: name }).click();
  await expect
    .poll(async () => (await select.locator(".agent-select__label").textContent())?.trim())
    .toBe(name);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a Gateway port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function fileList(agentId: string) {
  return {
    agentId,
    workspace: `/tmp/openclaw-e2e/workspace-${agentId}`,
    files: [
      {
        name: "AGENTS.md",
        path: `/tmp/openclaw-e2e/workspace-${agentId}/AGENTS.md`,
        missing: false,
      },
    ],
  };
}

function fileGet(agentId: string, content: string) {
  return {
    ...fileList(agentId),
    file: { ...fileList(agentId).files[0], content },
  };
}

function requestAgentId(request: { params?: unknown }) {
  return (request.params as { agentId?: unknown } | undefined)?.agentId;
}

const fileListResponses = {
  cases: [
    { match: { agentId: "main" }, response: fileList("main") },
    { match: { agentId: "writer" }, response: fileList("writer") },
    { response: fileList("main") },
  ],
};

function fileGetResponses(mainContent: string) {
  return {
    cases: [
      {
        match: { agentId: "main", name: "AGENTS.md" },
        response: fileGet("main", mainContent),
      },
      {
        match: { agentId: "writer", name: "AGENTS.md" },
        response: fileGet("writer", "# Writer instructions\n"),
      },
      { response: fileGet("main", mainContent) },
    ],
  };
}

suite.define(() => {
  it("keeps save errors visible, retries, and rejects stale cross-agent reads", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: [
                { id: "main", name: "Main" },
                { id: "writer", name: "Writer" },
              ],
            },
            "agents.files.get": fileGetResponses("# Main instructions\n"),
            "agents.files.list": fileListResponses,
            "agents.files.set": {
              __mockError: {
                code: "INTERNAL_ERROR",
                message: "workspace write failed; retry Save",
                retryable: true,
              },
            },
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        const editor = page.locator(".agent-file-textarea");
        const fileActions = page.locator(".agent-file-actions");
        const reset = fileActions.getByRole("button", { name: "Reset" });
        const save = fileActions.getByRole("button", { name: "Save" });
        const initialRead = await gateway.waitForRequest("agents.files.get");
        expect(initialRead.params).toMatchObject({ agentId: "main", name: "AGENTS.md" });
        await expect.poll(() => editor.inputValue()).toBe("# Main instructions\n");

        await editor.fill("temporary draft");
        await reset.click();
        await expect.poll(() => editor.inputValue()).toBe("# Main instructions\n");

        await editor.fill("Updated main instructions");
        await save.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.set")).length)
          .toBe(1);
        await expect
          .poll(() => page.getByText(/workspace write failed; retry Save/).isVisible())
          .toBe(true);
        expect(await gateway.getRequests("agents.files.list")).toHaveLength(1);
        await capture(page, "01-save-error-visible.png");

        await gateway.setMethodResponse("agents.files.set", {
          ok: true,
          ...fileGet("main", "Updated main instructions"),
        });
        await save.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.set")).length)
          .toBe(2);
        await expect
          .poll(() => page.getByText(/workspace write failed; retry Save/).count())
          .toBe(0);
        await expect.poll(() => save.isDisabled()).toBe(true);
        await capture(page, "02-save-retry-succeeded.png");

        await gateway.setMethodResponse(
          "agents.files.get",
          fileGetResponses("Updated main instructions"),
        );
        await gateway.deferNext("agents.files.get", { agentId: "writer", name: "AGENTS.md" });
        await selectAgent(page, "Writer");
        await expect
          .poll(async () =>
            (await gateway.getRequests("agents.files.get")).some(
              (request) => requestAgentId(request) === "writer",
            ),
          )
          .toBe(true);
        await selectAgent(page, "Main");
        await expect.poll(() => editor.inputValue()).toBe("Updated main instructions");
        await gateway.resolveDeferred("agents.files.get", fileGet("writer", "stale writer"));
        await expect.poll(() => editor.inputValue()).toBe("Updated main instructions");

        await selectAgent(page, "Writer");
        await expect.poll(() => editor.inputValue()).toBe("# Writer instructions\n");
        const writes = await gateway.getRequests("agents.files.set");
        expect(writes.every((request) => requestAgentId(request) === "main")).toBe(true);
        await capture(page, "03-writer-owned-file.png");
      },
    );
  });

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
    const gateway = await startGatewayServer(port, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });

    try {
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

          await selectAgent(page, "writer");
          await expect.poll(() => editor.inputValue()).toBe("# Real writer instructions\n");

          await selectAgent(page, "main");
          await editor.fill("# Saved through real Gateway\n");
          const save = page.locator(".agent-file-actions").getByRole("button", { name: "Save" });
          await save.click();
          await expect.poll(() => save.isDisabled()).toBe(true);
          await expect
            .poll(() => readFile(path.join(mainWorkspace, "AGENTS.md"), "utf8"))
            .toBe("# Saved through real Gateway\n");
          await capture(page, "04-real-gateway-main-save.png");
        },
      );
    } finally {
      await gateway.close({ reason: "agent file lifecycle e2e cleanup" });
      await state.cleanup();
    }
  });
});
