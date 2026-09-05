import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type {
  TerminalAckResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalListResult,
  TerminalOpenResult,
} from "../../../../packages/gateway-protocol/src/schema/terminal.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  type ControlUiBootstrapConfig,
} from "../../../../src/gateway/control-ui-bootstrap-contract.js";
import { openChatSidePanelType } from "../../../../ui/src/e2e/chat-side-panel.test-support.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

type TerminalProofParams = {
  gateway: QaGatewayChild;
  primary: HotReloadConnection;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown) => Promise<unknown>;
  http: (route: string) => Promise<{ status: number; text: string; headers: Headers }>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
};

export async function writeHotReloadTerminalCatalog(root: string): Promise<string> {
  const directory = path.join(root, "catalog-plugin");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "qa-hot-reload-shell",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "qa-hot-reload-shell",
      name: "Hot reload synthetic CLI catalog",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(directory, "index.mjs"),
    `export default {
    id: "qa-hot-reload-shell",
    name: "Hot reload synthetic CLI catalog",
    register(api) {
      api.registerSessionCatalog({
        id: "qa-hot-reload-shell", label: "Synthetic shell CLI", supportsProcessHomeIsolation: true,
        list: async () => [], read: async () => ({ items: [] }),
        startTerminalSession: async ({ cwd }) => ({ kind: "local", argv: ["/bin/sh"], cwd, title: "Synthetic CLI" }),
      });
    },
  };`,
  );
  return directory;
}

async function shellPid(
  connection: HotReloadConnection,
  terminal: TerminalOpenResult,
  label: string,
  write?: (command: string) => Promise<void>,
) {
  const cursor = connection.events.length;
  const marker = `HOT_TERMINAL_${label}`;
  // Separate the marker in stdin so echoed keystrokes cannot prove shell execution.
  const command = `printf '%s%s=%s\\n' 'HOT_TERMINAL_' '${label}' "$$"\n`;
  if (write) {
    await write(command);
  } else {
    const result = await connection.client.request<TerminalAckResult>("terminal.input", {
      sessionId: terminal.sessionId,
      data: command,
    });
    assert.equal(result.ok, true);
  }
  return await waitForHotReloadFact(`${label} shell PID output`, () => {
    const output = connection.events
      .slice(cursor)
      .flatMap((event) => {
        const payload = event.payload as TerminalDataEvent | undefined;
        return event.event === "terminal.data" && payload?.sessionId === terminal.sessionId
          ? [payload.data]
          : [];
      })
      .join("");
    const matched = output.match(new RegExp(`${marker}=(\\d+)`));
    return matched ? Number(matched[1]) : undefined;
  });
}

async function waitForShellExit(pid: number) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  await waitForHotReloadFact(`terminal shell ${pid} exit`, () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return true;
    }
  });
}

export async function proveHotReloadTerminalStartup({
  primary,
  rpc,
  patch,
  http,
  verifyContinuity,
  proveGroup,
}: TerminalProofParams) {
  await proveGroup("gateway.terminal.enabled.startup", async () => {
    const response = await http(CONTROL_UI_BOOTSTRAP_CONFIG_PATH);
    assert.equal(response.status, 200);
    const bootstrap = JSON.parse(response.text) as ControlUiBootstrapConfig;
    assert.equal(bootstrap.terminalEnabled, false);
    await assert.rejects(
      rpc("terminal.open", { agentId: "qa", cols: 80, rows: 24 }),
      /terminal is disabled/,
    );
    await patch({ gateway: { terminal: { enabled: true } } });
    const terminal = await rpc<TerminalOpenResult>("terminal.open", {
      agentId: "qa",
      cols: 80,
      rows: 24,
    });
    const pid = await shellPid(primary, terminal, "FIRST_ENABLE");
    assert.equal(
      (await rpc<TerminalAckResult>("terminal.close", { sessionId: terminal.sessionId })).ok,
      true,
    );
    await waitForShellExit(pid);
    await verifyContinuity(
      "gateway.terminal.enabled.startup",
      "The Gateway started disabled, rejected terminal.open, then hot enablement opened and executed a real PTY on the original boot",
    );
  });
  await patch({ gateway: { terminal: { enabled: true } } });
}

export async function proveHotReloadTerminalLifecycle({
  browser,
  outputDir,
  gateway,
  primary,
  rpc,
  patch,
  http,
  verifyContinuity,
  proveGroup,
}: TerminalProofParams & { browser: Browser; outputDir: string }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1280, height: 900 } },
    serviceWorkers: "block",
  });
  await context.addInitScript(
    ({ gatewayUrl, token }) => {
      Object.assign(window, { __OPENCLAW_NATIVE_CONTROL_AUTH__: { gatewayUrl, token } });
    },
    { gatewayUrl: gateway.wsUrl, token: gateway.token },
  );
  const page = await context.newPage();
  const video = page.video();
  page.setDefaultTimeout(20_000);
  let detachedConnection: HotReloadConnection | undefined;
  let loaded = false;
  const sessions = async () => (await rpc<TerminalListResult>("terminal.list")).sessions;
  const refresh = async (enabled: boolean) => {
    const response = loaded ? await page.reload() : await page.goto(`${gateway.baseUrl}/chat/qa`);
    loaded = true;
    assert(response);
    assert.equal(response.status(), 200);
    assert.equal(
      response.headers()["content-security-policy"]?.includes("'wasm-unsafe-eval'"),
      enabled,
    );
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    assert.equal(
      await page.locator("html").getAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE),
      String(enabled),
    );
    const bootstrapResponse = await http(CONTROL_UI_BOOTSTRAP_CONFIG_PATH);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = JSON.parse(bootstrapResponse.text) as ControlUiBootstrapConfig;
    assert.equal(bootstrap.terminalEnabled, enabled);
  };
  const terminalPanel = page.locator(".sidebar-region__right-runtime openclaw-terminal-panel");

  await proveGroup("gateway.terminal.enabled", async () => {
    await runQaGatewayFixture(
      async () => {
        // Run after the existing first-model-response probes, preserving their cold-start order.
        await rpc("sessions.create", { key: "agent:qa:main", agentId: "qa" });
        await patch({
          gateway: { terminal: { enabled: true, detachedSessionTimeoutSeconds: 300 } },
        });
        await refresh(true);
        const beforeUi = new Set((await sessions()).map((session) => session.sessionId));
        await openChatSidePanelType(page, "Terminal");
        await terminalPanel.locator(".tabstrip-tab.is-live").waitFor();
        const shared = await waitForHotReloadFact("chat-owned Control UI terminal", async () =>
          (await sessions()).find(
            (session) =>
              !beforeUi.has(session.sessionId) && session.owner === "agent:agent:qa:main",
          ),
        );
        await rpc("terminal.attach", { sessionId: shared.sessionId });
        const sharedPid = await shellPid(primary, shared, "CHAT", async (command) => {
          await terminalPanel.locator(".tp-host canvas").click();
          await page.keyboard.type(command.trimEnd());
          await page.keyboard.press("Enter");
        });
        const attached = await rpc<TerminalOpenResult>("terminal.open", {
          agentId: "qa",
          cols: 80,
          rows: 24,
        });
        const attachedPid = await shellPid(primary, attached, "ATTACHED");
        detachedConnection = await connectHotReloadClient(gateway);
        const detached = await detachedConnection.client.request<TerminalOpenResult>(
          "terminal.open",
          { agentId: "qa", cols: 80, rows: 24 },
        );
        const detachedPid = await shellPid(detachedConnection, detached, "DETACHED");
        await detachedConnection.client.stopAndWait({ timeoutMs: 2_000 });
        await waitForHotReloadFact("detached terminal remains alive", async () =>
          (await sessions()).find(
            (session) => session.sessionId === detached.sessionId && !session.attached,
          ),
        );
        await page.screenshot({ path: path.join(outputDir, "terminal-enabled.png") });

        const cursor = primary.events.length;
        await patch({ gateway: { terminal: { enabled: false } } });
        for (const sessionId of [attached.sessionId, shared.sessionId]) {
          await waitForHotReloadFact("terminal revocation event", () =>
            primary.events.slice(cursor).some((event) => {
              const payload = event.payload as TerminalExitEvent | undefined;
              return (
                event.event === "terminal.exit" &&
                payload?.sessionId === sessionId &&
                payload.reason === "closed"
              );
            })
              ? true
              : undefined,
          );
        }
        await Promise.all([attachedPid, detachedPid, sharedPid].map(waitForShellExit));
        assert.deepEqual(await sessions(), []);
        await assert.rejects(
          rpc("terminal.open", { agentId: "qa", cols: 80, rows: 24 }),
          /terminal is disabled/,
        );
        for (const sessionId of [attached.sessionId, detached.sessionId, shared.sessionId]) {
          assert.equal(
            (await rpc<TerminalAckResult>("terminal.input", { sessionId, data: "echo stale\n" }))
              .ok,
            false,
          );
          await assert.rejects(rpc("terminal.attach", { sessionId }), /terminal is not available/);
        }
        await refresh(false);
        assert.equal(await terminalPanel.locator(".tabstrip-tab.is-live").count(), 0);
        await page.screenshot({ path: path.join(outputDir, "terminal-disabled.png") });

        await patch({ gateway: { terminal: { enabled: true } } });
        for (const sessionId of [attached.sessionId, detached.sessionId, shared.sessionId]) {
          await assert.rejects(rpc("terminal.attach", { sessionId }), /unknown terminal/);
        }
        const fresh = await rpc<TerminalOpenResult>("terminal.open", {
          agentId: "qa",
          cols: 80,
          rows: 24,
        });
        const freshPid = await shellPid(primary, fresh, "REENABLED");
        await rpc("terminal.close", { sessionId: fresh.sessionId });
        await waitForShellExit(freshPid);
        await refresh(true);
        await terminalPanel
          .getByRole("button", { name: "New terminal session", exact: true })
          .click();
        await terminalPanel.locator(".tabstrip-tab.is-live").first().waitFor();
        await page.screenshot({ path: path.join(outputDir, "terminal-reenabled.png") });
        await verifyContinuity(
          "gateway.terminal.enabled",
          "Hot disable killed attached, detached, and chat-owned shell processes and denied open/input/attach; re-enable created fresh PTYs without reviving old IDs. Real Control UI reloads changed bootstrap, HTML CSP, and rendered terminal availability",
        );
      },
      () => context.close(),
      () => video?.saveAs(path.join(outputDir, "terminal-hot-reload.webm")),
      () => detachedConnection?.client.stopAndWait({ timeoutMs: 2_000 }),
      // Retire the final browser-owned PTY, then restore the following groups' prerequisite.
      () => patch({ gateway: { terminal: { enabled: false } } }),
      () => patch({ gateway: { terminal: { enabled: true } } }),
    );
  });
}
