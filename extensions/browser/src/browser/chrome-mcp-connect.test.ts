import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedChromeMcpProfileOptions } from "./chrome-mcp-contracts.js";
import { withChromeMcpLease } from "./chrome-mcp-routing.js";
import { closeChromeMcpSession, resetChromeMcpSessionsForTest } from "./chrome-mcp-session.js";
import { getChromeMcpPid } from "./chrome-mcp-tabs.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn<(message: string) => void>() }));

// Observe diagnostics before any additional logger redaction; keep the SDK and cleanup real.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ child: () => ({ warn }) }),
}));

describe("Chrome MCP subprocess startup diagnostics", () => {
  let state: OpenClawTestState;
  let profileName: string;
  let homeDir: string;
  let options: NormalizedChromeMcpProfileOptions;

  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    warn.mockClear();
    state = await createOpenClawTestState({ prefix: "chrome-mcp-startup-" });
    await state.writeConfig({ logging: { redactSensitive: "off" } });
    // Worker env overlays do not change native os.homedir(); the runner isolates both homes.
    homeDir = os.homedir();
    profileName = path.join(homeDir, "profiles", "fixture-profile");
    const userDataDir = path.join(homeDir, "chrome", "Profile 1");
    const command = await state.writeText(
      "mcp-server.mjs",
      String.raw`
import fs from "node:fs";
import readline from "node:readline";

fs.writeFileSync(new URL("./pid", import.meta.url), String(process.pid));
process.stdin.on("end", () => {
  if (process.argv[4] === "shutdown") writeStartupDiagnostic();
  fs.writeFileSync(new URL("./stdin-ended", import.meta.url), "closed");
});
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const detail = "startup-tail-é " + process.argv[3] + "/chrome/Profile 1 " +
  "wss://fixture-user:fixture-password@browser.example/chrome?token=fixture-token";
const writeStartupDiagnostic = () =>
  process.stderr.write("discarded-startup-prefix\n" + "x".repeat(9000) + "\n" + detail);
if (process.argv[4] === undefined) {
  writeStartupDiagnostic();
}
const failureMethod = process.argv[2];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === failureMethod) {
    send({ id: message.id, error: { code: -32000, message: "fixture attach failed: " + detail } });
  } else if (message.method === "initialize") {
    // A full stderr pipe must drain before the handshake can finish.
    process.stderr.write("x".repeat(Number(process.argv[4] ?? 0)), () => send({ id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-browser", version: "1.0.0" },
    } }));
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: [{ name: "list_pages", inputSchema: { type: "object" } }] } });
  } else if (message.method === "tools/call" && message.params.name === "list_pages") {
    send({ id: message.id, result: { content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }] } });
  } else {
    send({ id: message.id, error: { code: -32601, message: "Unknown fixture method" } });
  }
}
`,
    );
    options = { command: process.execPath, args: [command, "", homeDir], userDataDir };
  });

  async function expectSubprocessClosed() {
    const pid = Number(await fs.readFile(state.statePath("pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    await vi.waitFor(async () => {
      expect(await fs.readFile(state.statePath("stdin-ended"), "utf8")).toBe("closed");
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    });
    expect(getChromeMcpPid(profileName)).toBeNull();
  }

  afterEach(async () => {
    try {
      await resetChromeMcpSessionsForTest();
      await expectSubprocessClosed();
    } finally {
      await state.cleanup();
    }
  });

  it.each([
    { failureMethod: "initialize", ephemeral: false, stderrPhase: "startup" },
    { failureMethod: "initialize", ephemeral: true, stderrPhase: "startup" },
    { failureMethod: "tools/list", ephemeral: false, stderrPhase: "startup" },
    { failureMethod: "initialize", ephemeral: true, stderrPhase: "shutdown" },
  ])(
    "retains redacted $stderrPhase stderr on $failureMethod failure (ephemeral=$ephemeral)",
    async ({ failureMethod, ephemeral, stderrPhase }) => {
      options.args[1] = failureMethod;
      if (stderrPhase === "shutdown") {
        options.args.push(stderrPhase);
      }
      if (!ephemeral) {
        options.browserUrl =
          "wss://fixture-user:fixture-password@browser.example/chrome?token=fixture-token";
      }
      const attempt = withChromeMcpLease(profileName, options, { ephemeral }, async () => {
        throw new Error("failed startup must not admit an operation");
      });
      await expect(attempt).rejects.toThrow("fixture attach failed");
      await expect(attempt).rejects.toThrow("~/profiles/fixture-profile");
      await expect(attempt).rejects.toThrow("~/chrome/Profile 1");
      await expect(attempt).rejects.not.toThrow(/fixture-user|fixture-password|fixture-token/);
      await expect(attempt).rejects.not.toThrow(homeDir);
      await expectSubprocessClosed();

      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      const diagnostic = warn.mock.calls[0]![0];
      expect(diagnostic).toContain('profile "~/profiles/fixture-profile"');
      expect(diagnostic).toContain("startup-tail-é ~/chrome/Profile 1");
      expect(diagnostic).toContain("browser.example/chrome?token=");
      expect(diagnostic).not.toMatch(/fixture-user|fixture-password|fixture-token|�/);
      expect(diagnostic).not.toContain(homeDir);
      expect(diagnostic).not.toContain("discarded-startup-prefix");
      const tail = diagnostic.split("Subprocess stderr:\n")[1]!;
      expect(tail).toMatch(/^x+\nstartup-tail-é /);
      expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(8192);
    },
  );

  it.each([0, 2 * 1024 * 1024])(
    "keeps startup and tool calls usable with %i stderr bytes",
    async (stderrBytes) => {
      options.args.push(String(stderrBytes));
      const result = await withChromeMcpLease(profileName, options, {}, async ({ session }) =>
        session.client.callTool({ name: "list_pages", arguments: {} }),
      );
      expect(result).toMatchObject({
        content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
      });
      expect(getChromeMcpPid(profileName)).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
      await expect(closeChromeMcpSession(profileName)).resolves.toBe(true);
      await expectSubprocessClosed();
    },
    40_000,
  );
});
