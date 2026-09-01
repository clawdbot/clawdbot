import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "bare report with parent JSON",
      args: ["hooks", "--agent", "retired", "--json"],
    },
    {
      name: "list report with leaf JSON",
      args: ["hooks", "list", "--agent", "retired", "--json"],
    },
    {
      name: "list report with parent JSON",
      args: ["hooks", "--json", "list", "--agent", "retired"],
    },
    {
      name: "info report with leaf JSON",
      args: ["hooks", "info", "demo", "--agent", "retired", "--json"],
    },
    {
      name: "info report with parent JSON",
      args: ["hooks", "--json", "info", "demo", "--agent", "retired"],
    },
    {
      name: "check report with leaf JSON",
      args: ["hooks", "check", "--agent", "retired", "--json"],
    },
    {
      name: "check report with parent JSON",
      args: ["hooks", "--json", "check", "--agent", "retired"],
    },
    {
      name: "blank leaf agent",
      args: ["hooks", "list", "--agent", "", "--json"],
      message: "--agent must not be blank",
    },
    {
      name: "blank parent agent",
      args: ["hooks", "--agent", "", "--json", "list"],
      message: "--agent must not be blank",
    },
    {
      name: "human report",
      args: ["hooks", "list", "--agent", "retired"],
      human: true,
    },
    {
      name: "forced Commander report",
      args: ["hooks", "list", "--agent", "retired", "--json"],
      commander: true,
    },
    {
      name: "dual-TTY report",
      args: ["hooks", "check", "--agent", "retired", "--json"],
      tty: true,
    },
    {
      name: "configured remote Gateway missing its URL",
      args: ["hooks", "list", "--json"],
      message: "gateway remote mode misconfigured: gateway.remote.url missing",
      remoteMissing: true,
    },
    ...[
      { name: "default report", args: ["hooks", "--json"] },
      { name: "list report", args: ["hooks", "list", "--json"] },
      { name: "info report", args: ["hooks", "info", "demo", "--json"] },
      { name: "check report", args: ["hooks", "check", "--json"] },
    ].map(({ name, args }) => ({
      name: `${name} after an explicit environment Gateway fails`,
      args,
      message: "AUTOQA_SELECTED_GATEWAY_FAILURE",
      explicitGateway: true,
    })),
    {
      name: "injected local report failure",
      args: ["hooks", "list", "--json"],
      message: "injected hook report loading failure",
      reportFailure: true,
    },
    {
      name: "missing hook with leaf JSON",
      args: ["hooks", "info", "missing-hook", "--json"],
      message: 'Hook "missing-hook" not found.',
      missingHook: true,
    },
    {
      name: "missing hook with parent JSON",
      args: ["hooks", "--json", "info", "missing-hook"],
      message: 'Hook "missing-hook" not found.',
      missingHook: true,
    },
    {
      name: "missing hook through dual-TTY finalization",
      args: ["hooks", "info", "missing-hook", "--json"],
      message: 'Hook "missing-hook" not found.',
      missingHook: true,
      tty: true,
    },
    {
      name: "missing hook in human mode",
      args: ["hooks", "info", "missing-hook"],
      message: 'Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
      missingHook: true,
      human: true,
    },
  ])("renders hooks read failures through their canonical owner for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const workspaceHooksDir = path.join(stateDir, "workspace", "hooks");
        if ("remoteMissing" in testCase) {
          await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "remote" } }));
        }
        if ("reportFailure" in testCase) {
          await fs.mkdir(workspaceHooksDir, { recursive: true });
        }
        const socketError =
          "explicitGateway" in testCase
            ? "AUTOQA_SELECTED_GATEWAY_FAILURE"
            : "AUTOQA_NETWORK_FORBIDDEN";
        const socketErrorDetails =
          "explicitGateway" in testCase ? "{}" : '{ code: "ECONNREFUSED" }';
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            `net.Socket.prototype.connect = function () { throw Object.assign(new Error(${JSON.stringify(socketError)}), ${socketErrorDetails}); };`,
            'globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            ...("reportFailure" in testCase
              ? [
                  'import fs from "node:fs";',
                  "const originalReadDir = fs.readdirSync;",
                  `fs.readdirSync = (target, ...args) => { if (String(target) === ${JSON.stringify(workspaceHooksDir)}) { throw new Error("injected hook report loading failure"); } return originalReadDir(target, ...args); };`,
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
          OPENCLAW_GATEWAY_PORT: "29791",
          OPENCLAW_STATE_DIR: stateDir,
          ...("explicitGateway" in testCase
            ? {
                OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9",
                OPENCLAW_GATEWAY_TOKEN: "fixture-token",
              }
            : {}),
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
        });
        const message =
          "remoteMissing" in testCase
            ? [
                testCase.message,
                `Config: ${configPath}`,
                "Fix: set gateway.remote.url, or set gateway.mode=local.",
              ].join("\n")
            : (testCase.message ??
              'Unknown agent id "retired". Run openclaw agents list to see configured agents.');

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
        if ("human" in testCase) {
          if ("missingHook" in testCase) {
            expect(result.stdout.trim()).toBe(message);
          } else {
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(`Error: ${message}`);
          }
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
            ...("missingHook" in testCase ? { hook: "missing-hook" } : {}),
          });
          if (!("missingHook" in testCase)) {
            expect(result.stderr).toContain(message);
          }
        }
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        if ("remoteMissing" in testCase) {
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(
            JSON.stringify({ gateway: { mode: "remote" } }),
          );
        } else {
          await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
      { prefix: "openclaw-hooks-json-failure-e2e-" },
    );
  });

  it("preserves successful hooks report JSON and offline discovery", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, ["hooks", "--json", "list"], {
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_GATEWAY_PORT: "1",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(
          expect.objectContaining({ hooks: expect.any(Array) }),
        );
        expect(result.stderr).toBe("");
      },
      { prefix: "openclaw-hooks-json-success-e2e-" },
    );
  });
});
