import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "invalid call params in JSON mode",
      args: ["gateway", "call", "system-presence", "--params", "not-json", "--json"],
      message: "--params must be valid JSON.",
    },
    {
      name: "invalid call params in human mode",
      args: ["gateway", "call", "system-presence", "--params", "not-json"],
      message: "--params must be valid JSON.",
      human: true,
    },
    {
      name: "invalid call params through forced Commander",
      args: ["gateway", "call", "system-presence", "--params", "not-json", "--json"],
      message: "--params must be valid JSON.",
      commander: true,
    },
    {
      name: "invalid call params with dual TTYs",
      args: ["gateway", "call", "system-presence", "--params", "not-json", "--json"],
      message: "--params must be valid JSON.",
      tty: true,
    },
    {
      name: "contradictory usage options in JSON mode",
      args: ["gateway", "usage-cost", "--agent", "alpha", "--all-agents", "--json"],
      message: "Use --agent or --all-agents, not both",
    },
    {
      name: "contradictory usage options in human mode",
      args: ["gateway", "usage-cost", "--agent", "alpha", "--all-agents"],
      message: "Use --agent or --all-agents, not both",
      human: true,
    },
    {
      name: "contradictory usage options through forced Commander",
      args: ["gateway", "usage-cost", "--agent", "alpha", "--all-agents", "--json"],
      message: "Use --agent or --all-agents, not both",
      commander: true,
    },
    {
      name: "contradictory usage options with dual TTYs",
      args: ["gateway", "usage-cost", "--agent", "alpha", "--all-agents", "--json"],
      message: "Use --agent or --all-agents, not both",
      tty: true,
    },
    {
      name: "routed Gateway health config failure in JSON mode",
      args: ["gateway", "health", "--port", "29793", "--json"],
      message: "AUTOQA_ROUTE_CONFIG_READ_FAILURE",
      configReadFailure: true,
    },
    {
      name: "Gateway health config failure in human mode",
      args: ["gateway", "health", "--port", "29793"],
      message: "AUTOQA_ROUTE_CONFIG_READ_FAILURE",
      configReadFailure: true,
      human: true,
    },
    {
      name: "Gateway health config failure through forced Commander",
      args: ["gateway", "health", "--port", "29793", "--json"],
      message: "AUTOQA_ROUTE_CONFIG_READ_FAILURE",
      configReadFailure: true,
      commander: true,
    },
    {
      name: "routed Gateway health config failure with dual TTYs",
      args: ["gateway", "health", "--port", "29793", "--json"],
      message: "AUTOQA_ROUTE_CONFIG_READ_FAILURE",
      configReadFailure: true,
      tty: true,
    },
    {
      name: "specialized explicit Gateway authentication failure",
      args: ["gateway", "call", "system-presence", "--url", "ws://127.0.0.1:29793", "--json"],
      specializedAuth: true,
    },
  ])("renders Gateway query failures through the Gateway owner for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const stateDir = path.join(tempHome, "isolated-state");
        const gatewayError = "AUTOQA_INJECTED_GATEWAY_FAILURE";
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            `net.Socket.prototype.connect = function () { throw new Error(${JSON.stringify(gatewayError)}); };`,
            ...("configReadFailure" in testCase
              ? [
                  'import fs from "node:fs";',
                  "const originalExistsSync = fs.existsSync;",
                  "fs.existsSync = function (target, ...args) {",
                  '  if (String(target) === process.env.OPENCLAW_CONFIG_PATH && new Error().stack?.includes("readNonObservingHealthConfig")) {',
                  `    throw new Error(${JSON.stringify(testCase.message)});`,
                  "  }",
                  "  return originalExistsSync.call(this, target, ...args);",
                  "};",
                ]
              : []),
            ...("tty" in testCase
              ? [
                  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                ]
              : []),
          ].join("\n"),
        ).toString("base64");
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--import=data:text/javascript;base64,${preload}`,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { FORCE_COLOR: "1", NO_COLOR: undefined } : {}),
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
        expect(result.stdout).not.toContain(gatewayError);
        expect(result.stderr).not.toContain(gatewayError);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(testCase.message);
        } else if ("specializedAuth" in testCase) {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: {
              type: "gateway_credentials_required",
              message: [
                "gateway url override requires explicit credentials",
                "Fix: pass --token or --password with --url (or gatewayToken in tools).",
                "For the default local or SSH-tunneled Gateway, remove --url to use the configured target.",
                `Config: ${configPath}`,
              ].join("\n"),
            },
          });
          expect(result.stderr).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: testCase.message },
          });
          if ("configReadFailure" in testCase && !("commander" in testCase)) {
            expect(result.stderr).toContain(testCase.message);
          } else {
            expect(result.stderr).not.toContain(testCase.message);
          }
        }
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-gateway-query-json-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "routed status with JSON before its timeout",
      args: ["status", "--json", "--timeout", "nope"],
    },
    {
      name: "routed health with JSON after its timeout",
      args: ["health", "--timeout", "0", "--json"],
    },
    {
      name: "Commander status with JSON after its timeout",
      args: ["status", "--timeout", "nope", "--json"],
      commander: true,
    },
    {
      name: "Commander health with JSON before its timeout",
      args: ["health", "--json", "--timeout", "0"],
      commander: true,
    },
    {
      name: "routed status through dual-TTY finalization",
      args: ["status", "--json", "--timeout", "nope"],
      tty: true,
    },
  ])("renders invalid status/health timeouts as canonical JSON for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const result = runBuiltCli(tempHome, testCase.args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "29791",
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { NODE_OPTIONS: `--import=${preload}`, FORCE_COLOR: "1" } : {}),
        });
        const message = "--timeout must be a positive integer (milliseconds)";

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toContain("\u001B");
        expect(result.stdout, result.stderr).not.toContain("\u0007");
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: { type: "cli_error", message },
        });
        expect(result.stderr).toContain(message);
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-status-health-json-timeout-e2e-" },
    );
  });

  it.each([
    {
      name: "status with an invalid duration in human mode",
      args: ["nodes", "status", "--last-connected", "not-a-duration"],
      message: "Invalid --last-connected: Invalid duration",
      human: true,
    },
    {
      name: "status with JSON before its invalid duration",
      args: ["nodes", "status", "--json", "--last-connected", "not-a-duration"],
      message: "Invalid --last-connected: Invalid duration",
    },
    {
      name: "status with JSON after its invalid duration",
      args: ["nodes", "status", "--last-connected", "not-a-duration", "--json"],
      message: "Invalid --last-connected: Invalid duration",
    },
    {
      name: "list with an invalid duration in human mode",
      args: ["nodes", "list", "--last-connected", "not-a-duration"],
      message: "Invalid --last-connected: Invalid duration",
      human: true,
    },
    {
      name: "list with JSON before its invalid duration",
      args: ["nodes", "list", "--json", "--last-connected", "not-a-duration"],
      message: "Invalid --last-connected: Invalid duration",
    },
    {
      name: "list with JSON after its invalid duration",
      args: ["nodes", "list", "--last-connected", "not-a-duration", "--json"],
      message: "Invalid --last-connected: Invalid duration",
    },
    {
      name: "invoke with an explicitly JSON blank node",
      args: ["nodes", "invoke", "--node", "   ", "--command", "canvas.eval", "--json"],
      message: "--node and --command required",
    },
    {
      name: "invoke with an implicitly JSON blank node",
      args: ["nodes", "invoke", "--node", "   ", "--command", "canvas.eval"],
      message: "--node and --command required",
    },
    {
      name: "invoke with an explicitly JSON blank command",
      args: ["nodes", "invoke", "--node", "mac-1", "--command", "   ", "--json"],
      message: "--node and --command required",
    },
    {
      name: "invoke with an implicitly JSON blank command",
      args: ["nodes", "invoke", "--node", "mac-1", "--command", "   "],
      message: "--node and --command required",
    },
    {
      name: "rename with a blank name",
      args: ["nodes", "rename", "--node", "mac-1", "--name", "   ", "--json"],
      message: "--name must not be empty",
    },
  ])("renders nodes $name through the shared validation owner", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const denyNetwork = Buffer.from(
          `import net from "node:net";
           net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };
           globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };`,
        ).toString("base64");
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--permission --allow-fs-read=* --import=data:text/javascript;base64,${denyNetwork}`,
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_LOG_LEVEL: "silent",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
        });

        expect(result.status, result.stderr).toBe(1);
        if ("human" in testCase && testCase.human) {
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(`nodes ${testCase.args[1]} failed:`);
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: {
              type: "cli_error",
              message: expect.stringContaining(testCase.message),
            },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
      },
      { prefix: "openclaw-nodes-json-failure-e2e-" },
    );
  });
});
