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
  let ownsDescendant = false;
  let expectsSubprocess = true;

  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    warn.mockClear();
    ownsDescendant = false;
    expectsSubprocess = true;
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
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

fs.writeFileSync(new URL("./pid", import.meta.url), String(process.pid));
process.stdin.on("end", () => {
  fs.writeFileSync(new URL("./stdin-ended", import.meta.url), "closed");
});
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const detail = "startup-tail-é " + process.argv[3] + "/chrome/Profile 1 " +
  "wss://fixture-user:fixture-password@browser.example/chrome?token=fixture-token";
const writeDiagnostic = () => process.stderr.write("discarded-startup-prefix\n" + "x".repeat(9000) + "\n" + detail);
if (process.argv[5] === "stderr-on-close") {
  const child = spawn(process.execPath, ["-e", 'const fs = require("node:fs"); process.send("ready"); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 10);', new URL("./descendant-stop", import.meta.url).pathname], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message");
  fs.writeFileSync(new URL("./descendant-pid", import.meta.url), String(child.pid));
  child.disconnect();
  child.unref();
  process.stdin.on("end", writeDiagnostic);
} else if (process.argv[5] === "force-close") {
  process.on("SIGTERM", writeDiagnostic);
  setInterval(() => {}, 1000);
} else if (process.argv[4] === undefined) {
  writeDiagnostic();
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
      // Windows terminates the process tree before the transport can close stdin.
      if (process.platform !== "win32") {
        expect(await fs.readFile(state.statePath("stdin-ended"), "utf8")).toBe("closed");
      }
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    });
    expect(getChromeMcpPid(profileName)).toBeNull();
  }

  afterEach(async () => {
    try {
      await resetChromeMcpSessionsForTest();
      if (expectsSubprocess) {
        await expectSubprocessClosed();
      }
    } finally {
      if (ownsDescendant) {
        const pid = Number(await fs.readFile(state.statePath("descendant-pid"), "utf8"));
        await fs.writeFile(state.statePath("descendant-stop"), "stop");
        await vi.waitFor(() =>
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })),
        );
      }
      await state.cleanup();
    }
  });

  it.each([
    { failureMethod: "initialize", ephemeral: false, shutdownMode: "normal" },
    { failureMethod: "initialize", ephemeral: true, shutdownMode: "normal" },
    { failureMethod: "tools/list", ephemeral: false, shutdownMode: "normal" },
    // Windows deliberately taskkills before closing stdin; graceful EOF is POSIX-only.
    ...(process.platform === "win32"
      ? []
      : [
          { failureMethod: "initialize", ephemeral: true, shutdownMode: "stderr-on-close" },
          { failureMethod: "initialize", ephemeral: true, shutdownMode: "force-close" },
        ]),
  ])(
    "retains redacted stderr on $failureMethod failure (ephemeral=$ephemeral, shutdownMode=$shutdownMode)",
    async ({ failureMethod, ephemeral, shutdownMode }) => {
      options.args[1] = failureMethod;
      if (shutdownMode !== "normal") {
        ownsDescendant = shutdownMode === "stderr-on-close";
        options.args.push("0", shutdownMode);
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
      if (ownsDescendant) {
        const descendantPid = Number(await fs.readFile(state.statePath("descendant-pid"), "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
        expect(() => process.kill(descendantPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      }
      await expectSubprocessClosed();

      expect(warn).toHaveBeenCalledOnce();
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
    // Forced shutdown crosses the SDK's two 2-second grace windows.
    10_000,
  );

  it("reports an unspawnable command without waiting for an unused stderr pipe", async () => {
    expectsSubprocess = false;
    options.command = state.statePath("missing-mcp-command");
    const attempt = withChromeMcpLease(profileName, options, { ephemeral: true }, async () => {
      throw new Error("failed startup must not admit an operation");
    });

    await expect(attempt).rejects.toThrow("ENOENT");
    expect(warn).not.toHaveBeenCalled();
    expect(getChromeMcpPid(profileName)).toBeNull();
  });

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
