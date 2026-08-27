// CLI JSON stdout E2E tests validate machine-readable CLI output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readConfigMachineState } from "../src/state/config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";

function runBuiltCli(
  tempHome: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  options: { inheritEnvironment?: boolean } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...(options.inheritEnvironment === false ? { PATH: process.env.PATH } : process.env),
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.VITEST;
  Object.assign(env, envOverrides);

  const entry = path.resolve(process.cwd(), "openclaw.mjs");
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
}

async function seedTrajectorySession(tempHome: string, sessionKey: string) {
  const stateDir = path.join(tempHome, "isolated-state");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete env.OPENCLAW_HOME;
  const [{ upsertSessionEntryCore }, { closeOpenClawAgentDatabaseByPath }] = await Promise.all([
    import("../src/config/sessions/session-accessor.js"),
    import("../src/state/openclaw-agent-db.js"),
  ]);
  await upsertSessionEntryCore(
    { agentId: "main", env, sessionKey },
    { sessionId: "trajectory-process-session", updatedAt: 1 },
  );
  closeOpenClawAgentDatabaseByPath(
    path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  );
}

async function seedPendingStateMigration(stateDir: string) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    database.exec("PRAGMA user_version = 0;");
  } finally {
    database.close();
  }
}

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "implicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable"],
    },
    {
      name: "explicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable", "--json"],
    },
    {
      name: "automation alias implicit JSON",
      args: ["automations", "edit", "job-1", "--enable", "--disable"],
    },
    {
      name: "ordinary local validation failure",
      args: ["cron", "edit", "job-1", "--command-cwd", "", "--json"],
      message: "--command-cwd must not be blank",
    },
    {
      name: "Gateway failure implicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--port", "29793", "--token", "fixture-token"],
      gatewayRequest: true,
    },
    {
      name: "Gateway failure explicit JSON",
      args: [
        "cron",
        "edit",
        "job-1",
        "--enable",
        "--port",
        "29793",
        "--token",
        "fixture-token",
        "--json",
      ],
      gatewayRequest: true,
    },
    {
      name: "forced Commander JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable", "--json"],
      commander: true,
    },
    {
      name: "dual-TTY implicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable"],
      tty: true,
    },
    {
      name: "dual-TTY automation alias implicit JSON",
      args: ["automations", "edit", "job-1", "--enable", "--disable"],
      tty: true,
    },
    {
      name: "dual-TTY implicit JSON command sibling",
      args: ["cron", "runs", "--id", "job-1", "--limit", "invalid"],
      message: "Invalid --limit (must be a positive integer).",
      tty: true,
    },
    {
      name: "dual-TTY raw-output command sibling",
      args: ["cron", "scratch", "job-1", "--set", "updated", "--unset"],
      message: "choose only one of --set, --file, or --unset",
      tty: true,
    },
    {
      name: "dual-TTY explicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable", "--json"],
      tty: true,
    },
    {
      name: "human-output sibling",
      args: ["cron", "list", "--agent", ""],
      message: "--agent must not be blank",
      human: true,
    },
    {
      name: "dual-TTY human-output sibling",
      args: ["cron", "list", "--agent", ""],
      message: "--agent must not be blank",
      human: true,
      tty: true,
    },
  ])("renders cron edit failures through the shared owner for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const stateDir = path.join(tempHome, "isolated-state");
        const gatewayError = "AUTOQA_INJECTED_GATEWAY_FAILURE";
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            `net.Socket.prototype.connect = function () { throw new Error(${JSON.stringify(gatewayError)}); };`,
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
          ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
        });
        const message =
          "gatewayRequest" in testCase
            ? gatewayError
            : (testCase.message ?? "Choose --enable or --disable, not both");

        expect(result.status, result.stderr).toBe(1);
        if ("human" in testCase) {
          if ("tty" in testCase) {
            expect(result.stdout).toContain("OpenClaw");
          } else {
            expect(result.stdout).toBe("");
          }
        } else {
          expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        if ("gatewayRequest" in testCase) {
          expect(result.stderr).toContain(gatewayError);
        } else {
          expect(result.stderr).not.toContain(gatewayError);
          await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if ("tty" in testCase && !("human" in testCase)) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-cron-edit-json-failure-e2e-" },
    );
  });

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

  it.each([
    { name: "piped stdout", tty: false },
    { name: "dual TTYs", tty: true },
  ])("writes successful telemetry show JSON to clean $name", async ({ tty }) => {
    await withTempHome(
      async (tempHome) => {
        const ttyPreload = Buffer.from(
          [
            'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
            'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
          ].join("\n"),
        ).toString("base64");
        const result = runBuiltCli(tempHome, ["telemetry", "show", "--json"], {
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          ...(tty
            ? {
                NODE_OPTIONS: `--import=data:text/javascript;base64,${ttyPreload}`,
                FORCE_COLOR: "1",
              }
            : {}),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
        const payload = JSON.parse(result.stdout);
        expect(payload).toEqual({
          featureStatsEnabled: false,
          reason: "never-asked",
          endpoint: "https://telemetry.openclaw.ai/api/latest-version",
          lastPingAt: null,
          request: {
            method: "GET",
            userAgent: expect.stringMatching(/^openclaw\/[^ ]+ \(.+; gateway\)$/u),
          },
        });
        expect(result.stdout).toBe(`${JSON.stringify(payload)}\n`);
        expect(result.stderr).not.toContain('"featureStatsEnabled"');
      },
      { prefix: "openclaw-telemetry-json-success-e2e-" },
    );
  });

  it.each([
    { name: "leaf JSON", args: ["models", "refresh", "--json"] },
    { name: "parent JSON", args: ["models", "--json", "refresh"] },
    { name: "human output", args: ["models", "refresh"], human: true },
    {
      name: "forced Commander JSON",
      args: ["models", "refresh", "--json"],
      commander: true,
    },
    {
      name: "dual-TTY JSON",
      args: ["models", "refresh", "--json"],
      tty: true,
    },
  ])("renders model catalog refresh failures canonically for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
            "globalThis.fetch.mock = {};",
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
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
        });
        const message = "Remote catalog refresh failed: Error: offline fixture";

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        expect(result.stderr.split(message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-models-refresh-json-failure-e2e-" },
    );
  });

  // Every case opens the state database: config-health observation
  // (observeConfigSnapshot -> readConfigHealthStateFromStore) runs on any
  // config read whose file exists, so the migration diagnostic always lands
  // on stderr; the protected contract is that stdout stays exact.
  it.each([
    {
      name: "aliases list",
      args: ["models", "aliases", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "chat anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "fallbacks list",
      args: ["models", "fallbacks", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "image fallbacks list",
      args: ["models", "image-fallbacks", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "list control",
      args: ["models", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "status control",
      args: ["models", "status", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "parent status control",
      args: ["models", "--status-plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
  ])("keeps $name stdout exact during a pending state migration", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "openclaw.json");
        const migrationDiagnostic = "state database schema migration pending";
        await seedPendingStateMigration(stateDir);
        await fs.writeFile(
          configPath,
          JSON.stringify({
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-sonnet-4-6",
                  fallbacks: ["anthropic/claude-sonnet-4-6"],
                },
                imageModel: { fallbacks: ["anthropic/claude-sonnet-4-6"] },
                models: { "anthropic/claude-sonnet-4-6": { alias: "chat" } },
              },
            },
          }),
        );

        const result = runBuiltCli(
          tempHome,
          testCase.args,
          {
            CI: "1",
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          },
          { inheritEnvironment: false },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(testCase.expectedStdout);
        expect(result.stdout).not.toContain(migrationDiagnostic);
        expect(result.stderr.includes(migrationDiagnostic), result.stderr).toBe(
          testCase.opensStateDatabase,
        );
      },
      { prefix: "openclaw-models-plain-stdout-e2e-" },
    );
  });

  it.each(["--plain", "--json"])(
    "keeps human auth-list output on stdout when provider value is %s",
    async (provider) => {
      await withTempHome(
        async (tempHome) => {
          const result = runBuiltCli(tempHome, ["models", "auth", "list", "--provider", provider], {
            CI: "1",
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          });

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Agent: main\n");
          expect(result.stdout).toContain(`Provider: ${provider}\n`);
          expect(result.stdout).toContain("Profiles: (none)\n");
          expect(result.stderr).not.toContain("Agent: main");
          expect(result.stderr).not.toContain(`Provider: ${provider}`);
        },
        { prefix: "openclaw-models-output-option-value-e2e-" },
      );
    },
  );

  it("preserves model catalog refresh success payloads and persisted rows", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "openclaw.json");
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        const generatedAt = Date.now() + 60_000;
        const bundle = {
          schemaVersion: 1,
          generatedAt,
          sourceCommit: "autoqa-model-catalog-fixture",
          providers: { openai: { models: [{ id: "gpt-5.6-luna" }] } },
        };
        const updatedBundle = { ...bundle, generatedAt: generatedAt + 1_000 };
        const preloadFor = (response: "initial" | "updated" | "unchanged" | "failure") => {
          const fixture = response === "initial" ? bundle : updatedBundle;
          const fetchResponse =
            response === "failure"
              ? 'throw new Error("offline fixture");'
              : response === "unchanged"
                ? "return new Response(null, { status: 304 });"
                : `return new Response(JSON.stringify(${JSON.stringify(fixture)}), { headers: { etag: '\"fixture\"' } });`;
          return Buffer.from(
            [
              'import net from "node:net";',
              'import module from "node:module";',
              'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
              "const createRequire = module.createRequire;",
              'module.createRequire = (...args) => new Proxy(createRequire(...args), { apply(target, receiver, request) { return String(request[0]).endsWith("/build-info.json") ? { builtAt: "2020-01-01T00:00:00.000Z" } : Reflect.apply(target, receiver, request); } });',
              "module.syncBuiltinESMExports();",
              `globalThis.fetch = async () => { ${fetchResponse} };`,
              "globalThis.fetch.mock = {};",
            ].join("\n"),
          ).toString("base64");
        };
        const runRefresh = (
          args: string[],
          response: "initial" | "updated" | "unchanged" | "failure",
        ) =>
          runBuiltCli(tempHome, ["models", ...args], {
            NODE_OPTIONS: `--import=data:text/javascript;base64,${preloadFor(response)}`,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          });
        const readCatalogRow = () =>
          readConfigMachineState<{ generated_at: number; bundle_json: string }>(
            "modelCatalog.remote",
            { path: databasePath },
          );

        const human = runRefresh(["refresh"], "initial");
        expect(human.status, human.stderr).toBe(0);
        expect(human.stdout).toContain("Remote catalog refresh: updated (1 providers, 1 models;");
        expect(human.stdout).toContain(
          "A running Gateway applies the updated catalog after its next restart.",
        );

        const updated = runRefresh(["refresh", "--json"], "updated");
        expect(updated.status, updated.stderr).toBe(0);
        expect(JSON.parse(updated.stdout)).toEqual({
          status: "updated",
          generatedAt: updatedBundle.generatedAt,
          providers: 1,
          models: 1,
        });

        const unchanged = runRefresh(["--json", "refresh"], "unchanged");
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(JSON.parse(unchanged.stdout)).toEqual({
          status: "unchanged",
          generatedAt: updatedBundle.generatedAt,
          providers: 1,
          models: 1,
        });
        const persistedRow = readCatalogRow();
        expect(persistedRow).toMatchObject({
          generated_at: updatedBundle.generatedAt,
          bundle_json: JSON.stringify(updatedBundle),
        });

        const failure = runRefresh(["refresh", "--json"], "failure");
        expect(failure.status, failure.stderr).toBe(1);
        expect(JSON.parse(failure.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Remote catalog refresh failed: Error: offline fixture",
          },
        });
        expect(readCatalogRow()).toEqual(persistedRow);

        await fs.writeFile(
          configPath,
          `${JSON.stringify({ models: { catalogRefresh: { enabled: false } } })}\n`,
          "utf8",
        );
        const disabled = runRefresh(["refresh", "--json"], "failure");
        expect(disabled.status, disabled.stderr).toBe(0);
        expect(JSON.parse(disabled.stdout)).toEqual({
          status: "disabled",
          providers: 0,
          models: 0,
        });
        expect(readCatalogRow()).toEqual(persistedRow);
      },
      { prefix: "openclaw-models-refresh-persistence-e2e-" },
    );
  });

  it.each([
    {
      name: "add without an interactive terminal in human mode",
      args: ["agents", "add", "work"],
      message:
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
      human: true,
    },
    {
      name: "add without an interactive terminal in JSON wizard mode",
      args: ["agents", "add", "work", "--json"],
      message:
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
    },
    {
      name: "add without a workspace in human mode",
      args: ["agents", "add", "work", "--non-interactive"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
      human: true,
    },
    {
      name: "add without a workspace in explicit non-interactive mode",
      args: ["agents", "add", "work", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    },
    {
      name: "add without a workspace when a model selects automation",
      args: ["agents", "add", "work", "--model", "openai/gpt-5.6-luna", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    },
    {
      name: "add without a workspace before its missing name",
      args: ["agents", "add", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    },
    {
      name: "add without a name after a valid workspace",
      args: ["agents", "add", "--workspace", "$WORKSPACE", "--json"],
      message:
        "Agent name is required in non-interactive mode. Run openclaw agents add <id> --workspace <path>.",
    },
    {
      name: "add with an invalid agent id",
      args: ["agents", "add", "агент✨", "--workspace", "$WORKSPACE", "--json"],
      message:
        'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    },
    ...["openclaw", "crestodian"].map((agentId) => ({
      name: `add with reserved system-agent id ${agentId}`,
      args: ["agents", "add", agentId, "--workspace", "$WORKSPACE", "--json"],
      message: `"${agentId}" is reserved. Choose another name, or run openclaw agents list to inspect configured agents.`,
    })),
    {
      name: "add with an already-configured agent",
      args: ["agents", "add", "main", "--workspace", "$WORKSPACE", "--json"],
      message: 'Agent "main" already exists.',
    },
    {
      name: "add with a malformed binding",
      args: ["agents", "add", "work", "--workspace", "$WORKSPACE", "--bind", "telegram:", "--json"],
      message:
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
    },
    {
      name: "add with multiple malformed bindings in input order",
      args: [
        "agents",
        "add",
        "work",
        "--workspace",
        "$WORKSPACE",
        "--bind",
        "telegram:",
        "--bind",
        "telegram:work:extra",
        "--json",
      ],
      message: [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
      ].join("\n"),
    },
    {
      name: "add with an unknown binding channel",
      args: [
        "agents",
        "add",
        "work",
        "--workspace",
        "$WORKSPACE",
        "--bind",
        "definitely-not-a-channel",
        "--json",
      ],
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      name: "add with a normalized id before a malformed binding",
      args: ["agents", "add", "Work", "--workspace", "$WORKSPACE", "--bind", "telegram:", "--json"],
      message:
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
    },
    {
      name: "add without a workspace through dual-TTY finalization",
      args: ["agents", "add", "work", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
      tty: true,
    },
    {
      name: "add with a malformed binding through dual-TTY finalization",
      args: ["agents", "add", "work", "--workspace", "$WORKSPACE", "--bind", "telegram:", "--json"],
      message:
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
      tty: true,
    },
    {
      name: "bindings with an invalid agent",
      args: ["agents", "bindings", "--agent", "агент✨", "--json"],
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bindings with an unknown agent",
      args: ["agents", "bindings", "--json", "--agent", "ghost"],
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with an invalid agent",
      args: ["agents", "bind", "--agent", "агент✨", "--bind", "telegram", "--json"],
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with an unknown agent before missing bindings",
      args: ["agents", "bind", "--json", "--agent", "ghost"],
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind without bindings",
      args: ["agents", "bind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "bind with only a blank binding",
      args: ["agents", "bind", "--bind", "  ", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "bind with multiple malformed bindings in input order",
      args: ["agents", "bind", "--bind", "telegram:", "--bind", "telegram:work:extra", "--json"],
      message: [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
      ].join("\n"),
    },
    {
      name: "bind with an unknown channel",
      args: ["agents", "bind", "--json", "--bind", "definitely-not-a-channel"],
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      name: "unbind with an invalid agent",
      args: ["agents", "unbind", "--agent", "агент✨", "--all", "--json"],
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unbind with an unknown agent before incompatible options",
      args: ["agents", "unbind", "--agent", "ghost", "--all", "--bind", "telegram", "--json"],
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unbind without bindings",
      args: ["agents", "unbind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]> or use --all.",
    },
    {
      name: "unbind with a malformed binding",
      args: ["agents", "unbind", "--bind", "telegram:work:extra", "--json"],
      message:
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
    },
    {
      name: "unbind with incompatible options in human mode",
      args: ["agents", "unbind", "--all", "--bind", "telegram"],
      message: "Use either --all or --bind, not both.",
      human: true,
    },
    {
      name: "unbind with incompatible options in JSON mode",
      args: ["agents", "unbind", "--all", "--bind", "telegram", "--json"],
      message: "Use either --all or --bind, not both.",
    },
    {
      name: "bind without bindings through dual-TTY finalization",
      args: ["agents", "bind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
      tty: true,
    },
    {
      name: "set-identity with an unknown agent in human mode",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
      human: true,
    },
    {
      name: "set-identity with an unknown agent in JSON mode",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
    },
    {
      name: "set-identity with an invalid agent before identity-file resolution",
      args: ["agents", "set-identity", "--agent", "агент✨", "--from-identity", "--json"],
      message: 'Agent "агент✨" not found. Create it with `openclaw agents add`.',
    },
    {
      name: "set-identity with an unmatched workspace",
      args: ["agents", "set-identity", "--workspace", "$WORKSPACE", "--name", "Ghost", "--json"],
      message: "No agent workspace matches ~/workspace. Pass --agent to target a specific agent.",
    },
    {
      name: "set-identity with a missing workspace identity file",
      args: [
        "agents",
        "set-identity",
        "--agent",
        "main",
        "--workspace",
        "$WORKSPACE",
        "--from-identity",
        "--json",
      ],
      message: "No identity data found in ~/workspace/IDENTITY.md.",
    },
    {
      name: "set-identity with a missing explicit identity file",
      args: [
        "agents",
        "set-identity",
        "--agent",
        "main",
        "--identity-file",
        "$WORKSPACE",
        "--json",
      ],
      message: "No identity data found in ~/workspace.",
    },
    {
      name: "set-identity with an unknown agent through dual-TTY finalization",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
      tty: true,
    },
  ])("renders agent management $name through the canonical failure owner", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const workspace = path.join(tempHome, "workspace");
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const args = testCase.args.map((argument) =>
          argument === "$WORKSPACE" ? workspace : argument,
        );
        const result = runBuiltCli(tempHome, args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: configPath,
          ...("tty" in testCase ? { NODE_OPTIONS: `--import=${preload}`, FORCE_COLOR: "1" } : {}),
        });

        expect(result.status, result.stderr).toBe(1);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: testCase.message },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr.split(testCase.message)).toHaveLength(2);
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-agent-management-json-failure-e2e-" },
    );
  });

  it("leaves existing config and IDENTITY.md untouched when set-identity rejects an agent", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        const workspace = path.join(tempHome, "workspace");
        const identityPath = path.join(workspace, "IDENTITY.md");
        const originalConfig = `${JSON.stringify({
          agents: { entries: { main: { workspace, identity: { name: "Original" } } } },
        })}\n`;
        const originalIdentity = "- Name: Original workspace identity\n";
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(configPath, originalConfig, "utf8");
        await fs.writeFile(identityPath, originalIdentity, "utf8");

        const result = runBuiltCli(
          tempHome,
          ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
          {
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: configPath,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
          },
        });
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(originalConfig);
        await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
      },
      { prefix: "openclaw-agent-identity-json-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "bindings list success",
      args: ["agents", "bindings", "--json"],
      payload: [],
    },
    {
      name: "bind success",
      args: ["agents", "bind", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        added: ["telegram accountId=work"],
        updated: [],
        skipped: [],
        conflicts: [],
      },
      writesConfig: true,
    },
    {
      name: "unbind-all success",
      args: ["agents", "unbind", "--all", "--json"],
      payload: { agentId: "main", removed: [], missing: [], conflicts: [] },
    },
    {
      name: "bind ownership conflict",
      args: ["agents", "bind", "--agent", "main", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        added: [],
        updated: [],
        skipped: [],
        conflicts: ["telegram accountId=work (agent=ops)"],
      },
      conflict: true,
    },
    {
      name: "unbind ownership conflict",
      args: ["agents", "unbind", "--agent", "main", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        removed: [],
        missing: [],
        conflicts: ["telegram accountId=work (agent=ops)"],
      },
      conflict: true,
    },
  ])("preserves agent binding $name as its existing domain payload", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        const existingConfig = `${JSON.stringify({
          agents: {
            ownership: "explicit",
            list: [
              { id: "main", workspace: path.join(tempHome, "main") },
              { id: "ops", workspace: path.join(tempHome, "ops") },
            ],
          },
          bindings: [
            { type: "route", agentId: "ops", match: { channel: "telegram", accountId: "work" } },
          ],
        })}\n`;
        if ("conflict" in testCase) {
          await fs.writeFile(configPath, existingConfig, "utf8");
        }

        const result = runBuiltCli(tempHome, testCase.args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: configPath,
        });

        expect(result.status, result.stderr).toBe("conflict" in testCase ? 1 : 0);
        expect(result.stdout, result.stderr).not.toBe("");
        expect(JSON.parse(result.stdout)).toEqual(testCase.payload);
        if ("writesConfig" in testCase) {
          await expect(fs.access(configPath)).resolves.toBeUndefined();
        } else if ("conflict" in testCase) {
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(existingConfig);
        } else {
          await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
      { prefix: "openclaw-agent-bindings-domain-payload-e2e-" },
    );
  });

  it.each([
    {
      name: "routed config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: {},
    },
    {
      name: "Commander config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
    },
    {
      name: "Nix config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: { OPENCLAW_NIX_MODE: "1" },
    },
    { name: "config schema", args: ["config", "schema"], overrides: {} },
    {
      name: "Nix config schema",
      args: ["config", "schema"],
      overrides: { OPENCLAW_NIX_MODE: "1" },
    },
    { name: "config validate", args: ["config", "validate", "--json"], overrides: {} },
    {
      name: "Nix config validate",
      args: ["config", "validate", "--json"],
      overrides: { OPENCLAW_NIX_MODE: "1" },
    },
  ])("does not initialize shared SQLite for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-openclaw.json");
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ gateway: { mode: "local", port: 18789 } })}\n`,
          "utf8",
        );

        const result = runBuiltCli(tempHome, testCase.args, {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          ...testCase.overrides,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        await expect(
          fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-read-only-config-e2e-" },
    );
  });

  it.each([
    { name: "routed malformed config get", overrides: {} },
    {
      name: "Commander malformed config get",
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
    },
  ])("returns actionable JSON without creating state for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf8");

        const result = runBuiltCli(
          tempHome,
          ["config", "get", "gateway.__proto__.token", "--json"],
          {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
            ...testCase.overrides,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("Invalid path segment: __proto__"),
          },
        });
        expect(result.stderr).toBe("");
        await expect(
          fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-read-only-invalid-config-e2e-" },
    );
  });

  it.each([
    { name: "routed invalid config get", overrides: {} },
    {
      name: "Commander invalid config get",
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
    },
  ])("reports invalid configuration as JSON without creating state for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-openclaw.json");
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ gateway: { bind: "not-a-supported-mode" } })}\n`,
          "utf8",
        );

        const result = runBuiltCli(tempHome, ["config", "get", "gateway.port", "--json"], {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          ...testCase.overrides,
        });

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("OpenClaw config is invalid"),
          },
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "gateway.bind", message: expect.any(String) }),
          ]),
        });
        expect(result.stderr).toBe("");
        await expect(
          fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-read-only-invalid-snapshot-e2e-" },
    );
  });

  it.each([
    { name: "default service", inheritedProfile: undefined, inheritedStateName: ".openclaw" },
    { name: "named service", inheritedProfile: "main", inheritedStateName: ".openclaw-main" },
  ])("resolves the requested profile from inherited $name state", async (inherited) => {
    await withTempHome(
      async (tempHome) => {
        const inheritedStateDir = path.join(tempHome, inherited.inheritedStateName);
        const result = runBuiltCli(tempHome, ["--profile", "work", "config", "file"], {
          OPENCLAW_PROFILE: inherited.inheritedProfile,
          OPENCLAW_STATE_DIR: inheritedStateDir,
          OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(tempHome, ".openclaw-work", "openclaw.json"));
        await expect(fs.access(path.join(tempHome, ".openclaw-work"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-profile-isolation-e2e-" },
    );
  });

  it("keeps default-profile exec approvals untouched for a scratch-state config query", async () => {
    await withTempHome(
      async (tempHome) => {
        const defaultStateDir = path.join(tempHome, ".openclaw");
        const scratchStateDir = path.join(tempHome, "scratch-state");
        const approvalsPath = path.join(defaultStateDir, "exec-approvals.json");
        const approvals = '{"version":1,"approvals":{"demo":true}}\n';
        await fs.mkdir(defaultStateDir, { recursive: true });
        await fs.mkdir(scratchStateDir, { recursive: true });
        await fs.writeFile(approvalsPath, approvals, "utf8");

        const result = runBuiltCli(tempHome, ["config", "file"], {
          OPENCLAW_STATE_DIR: scratchStateDir,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(scratchStateDir, "openclaw.json"));
        await expect(fs.readFile(approvalsPath, "utf8")).resolves.toBe(approvals);
        await expect(fs.access(`${approvalsPath}.migrated`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.access(path.join(scratchStateDir, "exec-approvals.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.access(path.join(scratchStateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-read-only-state-e2e-" },
    );
  });

  it("keeps `update status --json` stdout parseable even with legacy doctor preflight inputs", async () => {
    await withTempHome(
      async (tempHome) => {
        const legacyDir = path.join(tempHome, ".clawdbot");
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(path.join(legacyDir, "clawdbot.json"), "{}", "utf8");

        const result = runBuiltCli(tempHome, ["update", "status", "--json", "--timeout", "1"]);

        expect(result.status).toBe(0);
        const stdout = result.stdout.trim();
        expect(stdout.length).toBeGreaterThan(0);
        const parsed = JSON.parse(stdout) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Expected JSON object stdout, got: ${stdout}`);
        }
        expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toEqual([
          "availability",
          "channel",
          "update",
        ]);
        expect(stdout).not.toContain("Doctor warnings");
        expect(stdout).not.toContain("Doctor changes");
        expect(stdout).not.toContain("Config invalid");
      },
      { prefix: "openclaw-json-e2e-" },
    );
  });

  it("rejects an explicitly empty update status timeout before emitting JSON", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, ["update", "status", "--json", "--timeout", ""]);

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "--timeout must be a positive integer (seconds)",
          },
        });
        expect(result.stderr).toContain("--timeout must be a positive integer (seconds)");
      },
      { prefix: "openclaw-update-empty-timeout-e2e-" },
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
      name: "bare list active filter in human mode",
      args: ["sessions", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      human: true,
    },
    {
      name: "bare list limit in human mode through forced Commander",
      args: ["sessions", "--limit", "0"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      human: true,
      commander: true,
    },
    {
      name: "routed bare list active filter with JSON before its option",
      args: ["sessions", "--json", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "routed bare list limit with JSON after its option",
      args: ["sessions", "--limit", "0", "--json"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
    },
    {
      name: "Commander bare list active filter with JSON after its option",
      args: ["sessions", "--active", "0", "--json"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      commander: true,
    },
    {
      name: "Commander bare list limit with JSON before its option",
      args: ["sessions", "--json", "--limit", "0"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      commander: true,
    },
    {
      name: "list alias active filter with inherited parent JSON",
      args: ["sessions", "--json", "list", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "list alias limit with leaf JSON",
      args: ["sessions", "list", "--limit", "0", "--json"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
    },
    {
      name: "bare list active filter before an invalid limit",
      args: ["sessions", "--json", "--limit", "0", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "routed bare list active filter through dual-TTY finalization",
      args: ["sessions", "--json", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      tty: true,
    },
    {
      name: "Commander bare list limit through dual-TTY finalization",
      args: ["sessions", "--limit", "0", "--json"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      commander: true,
      tty: true,
    },
    {
      name: "cleanup with an inherited filter in human mode",
      args: ["sessions", "--active", "5", "cleanup"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
      human: true,
    },
    {
      name: "cleanup inherited filter with leaf JSON",
      args: ["sessions", "--active", "5", "cleanup", "--json"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
    },
    {
      name: "cleanup inherited limit with parent JSON",
      args: ["sessions", "--json", "--limit", "1", "cleanup"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --limit; session-list filters cannot scope session maintenance.",
    },
    {
      name: "trajectory export inherited all-agent scope",
      args: [
        "sessions",
        "--all-agents",
        "export-trajectory",
        "--session-key",
        "agent:main:main",
        "--json",
      ],
      message:
        "`sessions export-trajectory` does not support the parent `sessions` option --all-agents; trajectory export targets one session and cannot apply session-list filters.",
    },
    {
      name: "trajectory export missing session key in human mode",
      args: ["sessions", "export-trajectory"],
      message: "--session-key is required. Run openclaw sessions to choose a session.",
      human: true,
    },
    {
      name: "trajectory export missing session key with leaf JSON",
      args: ["sessions", "export-trajectory", "--json"],
      message: "--session-key is required. Run openclaw sessions to choose a session.",
    },
    {
      name: "trajectory export missing session key with parent JSON through forced Commander",
      args: ["sessions", "--json", "export-trajectory"],
      message: "--session-key is required. Run openclaw sessions to choose a session.",
      commander: true,
    },
    {
      name: "trajectory export malformed encoded request",
      args: [
        "sessions",
        "export-trajectory",
        "--request-json-base64",
        Buffer.from("not json", "utf8").toString("base64url"),
        "--json",
      ],
      message:
        "Failed to decode trajectory export request: Encoded trajectory export request is invalid JSON",
    },
    {
      name: "trajectory export noncanonical encoded request with parent JSON",
      args: [
        "sessions",
        "--json",
        "export-trajectory",
        "--request-json-base64",
        ` ${Buffer.from(JSON.stringify({ sessionKey: "agent:main:test" })).toString("base64url")} `,
      ],
      message:
        "Failed to decode trajectory export request: Encoded trajectory export request is invalid",
    },
    {
      name: "trajectory export blank explicit agent",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:test",
        "--agent",
        "",
        "--json",
      ],
      message: "--agent must not be blank",
    },
    {
      name: "trajectory export unconfigured explicit agent",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:test",
        "--agent",
        "unknown-agent",
        "--json",
      ],
      message:
        'Unknown agent id "unknown-agent". Run openclaw agents list to see configured agents.',
    },
    {
      name: "trajectory export missing session through dual-TTY finalization",
      args: ["sessions", "export-trajectory", "--session-key", "agent:main:missing", "--json"],
      message:
        "Session not found: agent:main:missing. Run openclaw sessions to see available sessions.",
      tty: true,
    },
    {
      name: "trajectory export invalid explicit store",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:trajectory-process",
        "--store",
        "$MISSING_STORE",
        "--json",
      ],
      message:
        "Session store target does not exist: $MISSING_STORE. Pass a selector whose resolved SQLite target exists.",
    },
    {
      name: "trajectory exporter operational failure",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:trajectory-process",
        "--workspace",
        "$TRAJECTORY_WORKSPACE",
        "--json",
      ],
      message: "Failed to export trajectory: injected trajectory exporter failure",
      exporterFailure: true,
    },
    {
      name: "archive inherited store with leaf JSON",
      args: ["sessions", "--store", "/tmp/other.sqlite", "archive", "agent:main:test", "--json"],
      message:
        "`sessions archive` does not support the parent `sessions` option --store; the gateway resolves target stores from each key and --agent.",
    },
    {
      name: "archive invalid timeout with parent JSON",
      args: ["sessions", "--json", "archive", "agent:main:test", "--timeout", "0"],
      message: "--timeout must be a positive integer (milliseconds).",
    },
    {
      name: "delete inherited all-agent scope",
      args: ["sessions", "--all-agents", "delete", "agent:main:test", "--yes", "--json"],
      message:
        "`sessions delete` does not support the parent `sessions` option --all-agents; the gateway resolves target stores from each key and --agent.",
    },
    {
      name: "delete invalid timeout with leaf JSON",
      args: ["sessions", "delete", "agent:main:test", "--timeout", "nope", "--yes", "--json"],
      message: "--timeout must be a positive integer (milliseconds).",
    },
    {
      name: "compact inherited all-agent scope",
      args: ["sessions", "--all-agents", "compact", "agent:main:test", "--json"],
      message:
        "`sessions compact` does not support the parent `sessions` option --all-agents; the gateway resolves the target store from <key> and --agent.",
    },
    {
      name: "compact invalid max-lines with leaf JSON",
      args: ["sessions", "compact", "agent:main:test", "--max-lines", "0", "--json"],
      message: "--max-lines must be a positive integer.",
    },
    {
      name: "compact invalid timeout with parent JSON",
      args: ["sessions", "--json", "compact", "agent:main:test", "--timeout", "0"],
      message: "--timeout must be a positive integer (milliseconds).",
    },
    {
      name: "human-only tail rejecting inherited JSON",
      args: ["sessions", "--json", "tail"],
      message:
        "`sessions tail` does not support the parent `sessions` option --json; trajectory tail emits human-readable progress and selects sessions separately.",
    },
    {
      name: "cleanup inherited filter through forced Commander",
      args: ["sessions", "--active", "5", "cleanup", "--json"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
      commander: true,
    },
    {
      name: "compact invalid max-lines through dual-TTY finalization",
      args: ["sessions", "compact", "agent:main:test", "--max-lines", "0", "--json"],
      message: "--max-lines must be a positive integer.",
      tty: true,
    },
  ])("renders sessions list and registration validation failures for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        if ("exporterFailure" in testCase) {
          await seedTrajectorySession(tempHome, "agent:main:trajectory-process");
        }
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            'globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            ...("exporterFailure" in testCase
              ? [
                  'import fs from "node:fs/promises";',
                  "const originalRealpath = fs.realpath;",
                  `fs.realpath = async (target, ...args) => { if (target === ${JSON.stringify(tempHome)}) { throw new Error("injected trajectory exporter failure"); } return originalRealpath(target, ...args); };`,
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
        const missingStore = path.join(tempHome, "missing-store.sqlite");
        const args = testCase.args.map((arg) =>
          arg === "$TRAJECTORY_WORKSPACE"
            ? tempHome
            : arg === "$MISSING_STORE"
              ? missingStore
              : arg,
        );
        const message = testCase.message.replace("$MISSING_STORE", missingStore);
        const result = runBuiltCli(tempHome, args, {
          NODE_OPTIONS: `--import=data:text/javascript;base64,${preload}`,
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "29791",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toContain("\u001B");
        expect(result.stdout, result.stderr).not.toContain("\u0007");
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        expect(result.stderr.split(message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-sessions-registration-json-failure-e2e-" },
    );
  });

  it.each([
    { name: "direct JSON export", encoded: false, json: true },
    { name: "encoded request precedence with plain output", encoded: true, json: false },
  ])("preserves successful trajectory $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const sessionKey = "agent:main:trajectory-process";
        await seedTrajectorySession(tempHome, sessionKey);
        const output = testCase.encoded ? "encoded-export" : "direct-export";
        const args = [
          "sessions",
          "export-trajectory",
          "--session-key",
          testCase.encoded ? "agent:main:missing" : sessionKey,
          "--output",
          "direct-export",
          "--workspace",
          tempHome,
        ];
        if (testCase.encoded) {
          args.push(
            "--request-json-base64",
            Buffer.from(JSON.stringify({ sessionKey, output }), "utf8").toString("base64url"),
          );
        }
        if (testCase.json) {
          args.push("--json");
        }

        const result = runBuiltCli(tempHome, args, {
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "29791",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
        });

        expect(result.status, result.stderr).toBe(0);
        if (testCase.json) {
          expect(JSON.parse(result.stdout)).toMatchObject({
            displayPath: `.openclaw/trajectory-exports/${output}`,
            sessionId: "trajectory-process-session",
          });
        } else {
          expect(result.stdout).toContain("✅ Trajectory exported!");
          expect(result.stdout).toContain(`.openclaw/trajectory-exports/${output}`);
          expect(result.stdout).toContain("trajectory-process-session");
        }
        await expect(
          fs.access(
            path.join(tempHome, ".openclaw", "trajectory-exports", output, "manifest.json"),
          ),
        ).resolves.toBeUndefined();
      },
      { prefix: "openclaw-trajectory-success-e2e-" },
    );
  });

  it.each([
    {
      name: "account validation in human mode",
      args: ["channels", "capabilities", "--account", "ghost"],
      message: "--account requires a specific --channel. Run openclaw channels list to choose one.",
      human: true,
    },
    {
      name: "account validation with JSON before its option",
      args: ["channels", "capabilities", "--json", "--account", "ghost"],
      message: "--account requires a specific --channel. Run openclaw channels list to choose one.",
    },
    {
      name: "target validation with JSON after its option and explicit Commander routing",
      args: ["channels", "capabilities", "--target", "channel:1", "--json"],
      message: "--target requires a specific --channel. Run openclaw channels list to choose one.",
      commander: true,
    },
    {
      name: "unknown channel validation with JSON before its option",
      args: ["channels", "capabilities", "--json", "--channel", "definitely-not-a-channel"],
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      name: "account validation through dual-TTY finalization",
      args: ["channels", "capabilities", "--account", "ghost", "--json"],
      message: "--account requires a specific --channel. Run openclaw channels list to choose one.",
      tty: true,
    },
  ])(
    "renders channels capabilities $name through the canonical failure owner",
    async (testCase) => {
      await withTempHome(
        async (tempHome) => {
          const preload = Buffer.from(
            [
              'import net from "node:net";',
              'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
              'globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
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
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_GATEWAY_PORT: "29871",
            ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
            ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
          });

          expect(result.status, result.stderr).toBe(1);
          if ("human" in testCase) {
            expect(result.stdout).toBe("");
          } else {
            expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
            expect(JSON.parse(result.stdout)).toEqual({
              ok: false,
              error: { type: "cli_error", message: testCase.message },
            });
          }
          expect(result.stderr).toContain(testCase.message);
          expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
          if ("tty" in testCase) {
            expect(result.stderr).toContain("\u001B[?25h");
          }
        },
        { prefix: "openclaw-channels-capabilities-failure-e2e-" },
      );
    },
  );

  it("returns one canonical document for a command that previously failed on stderr only", async () => {
    await withTempHome(
      async (tempHome) => {
        const missingArchive = path.join(tempHome, "missing-backup.tar.gz");
        const result = runBuiltCli(tempHome, ["backup", "verify", missingArchive, "--json"]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("missing-backup.tar.gz"),
          },
        });
      },
      { prefix: "openclaw-json-failure-e2e-" },
    );
  });

  it("renders a missing TaskFlow as one canonical JSON document without stderr", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, ["tasks", "flow", "show", "missing-flow", "--json"]);

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message:
              "TaskFlow not found: missing-flow. Run openclaw tasks flow list to see recent flow ids.",
          },
        });
        expect(result.stderr).toBe("");
      },
      { prefix: "openclaw-task-flow-json-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "audit limit in human mode",
      args: ["tasks", "audit", "--limit", "5abc"],
      message: "--limit must be a positive integer, for example --limit 25.",
      human: true,
    },
    {
      name: "notify policy in human mode",
      args: ["tasks", "notify", "task-123", "sometimes"],
      message: "Notify policy must be done_only, state_changes, or silent.",
      human: true,
    },
    {
      name: "routed audit limit with leaf JSON",
      args: ["tasks", "audit", "--json", "--limit", "5abc"],
      message: "--limit must be a positive integer, for example --limit 25.",
    },
    {
      name: "routed audit limit with parent JSON",
      args: ["tasks", "--json", "audit", "--limit", "5abc"],
      message: "--limit must be a positive integer, for example --limit 25.",
    },
    {
      name: "Commander audit limit with leaf JSON",
      args: ["tasks", "audit", "--limit", "5abc", "--json"],
      message: "--limit must be a positive integer, for example --limit 25.",
      commander: true,
    },
    {
      name: "Commander audit limit with parent JSON",
      args: ["tasks", "--json", "audit", "--limit", "5abc"],
      message: "--limit must be a positive integer, for example --limit 25.",
      commander: true,
    },
    {
      name: "routed audit with an inherited runtime",
      args: ["tasks", "--json", "--runtime", "cli", "audit"],
      message: "`tasks audit` does not support inherited option --runtime.",
    },
    {
      name: "Commander audit with an inherited status",
      args: ["tasks", "--json", "--status", "running", "audit"],
      message: "`tasks audit` does not support inherited option --status.",
      commander: true,
    },
    {
      name: "routed maintenance with an inherited runtime",
      args: ["tasks", "--runtime", "cli", "maintenance", "--json"],
      message: "`tasks maintenance` does not support inherited option --runtime.",
    },
    {
      name: "routed TaskFlow list with an inherited task status",
      args: ["tasks", "--json", "--status", "running", "flow", "list"],
      message: "`tasks flow list` does not support inherited option --status.",
    },
    {
      name: "Commander TaskFlow show with an inherited runtime",
      args: ["tasks", "--runtime", "cli", "flow", "--json", "show", "flow-123"],
      message: "`tasks flow show` does not support inherited option --runtime.",
      commander: true,
    },
    {
      name: "routed audit limit through dual-TTY finalization",
      args: ["tasks", "audit", "--json", "--limit", "5abc"],
      message: "--limit must be a positive integer, for example --limit 25.",
      tty: true,
    },
  ])("renders task registration validation failures for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const result = runBuiltCli(tempHome, testCase.args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { NODE_OPTIONS: `--import=${preload}`, FORCE_COLOR: "1" } : {}),
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: testCase.message },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr.split(testCase.message)).toHaveLength(2);
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-task-registration-json-failure-e2e-" },
    );
  });

  it.each([
    { name: "qr", command: ["qr"] },
    { name: "clawbot qr", command: ["clawbot", "qr"] },
  ])("renders conflicting $name options as one canonical JSON document", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        for (const conflict of [
          {
            args: ["--limited", "--voice-node"],
            message: "Use either --limited or --voice-node, not both.",
          },
          {
            args: ["--token", "test-token", "--password", "test-password"],
            message: "Use either --token or --password, not both.",
          },
        ]) {
          const result = runBuiltCli(tempHome, [...testCase.command, "--json", ...conflict.args], {
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          });

          expect(result.status, result.stderr).toBe(1);
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: conflict.message },
          });
          expect(result.stdout).not.toContain("[openclaw]");
          expect(result.stderr).toContain(conflict.message);
        }
      },
      { prefix: "openclaw-qr-json-failure-e2e-" },
    );
  });

  it("renders sandbox explain validation failures as one canonical JSON document", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, [
          "sandbox",
          "explain",
          "--json",
          "--agent",
          "alpha",
          "--session",
          "agent:beta:main",
        ]);

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: 'Sandbox explain agent "alpha" does not match session agent "beta".',
          },
        });
        expect(result.stderr).toContain(
          'Sandbox explain agent "alpha" does not match session agent "beta".',
        );
      },
      { prefix: "openclaw-sandbox-json-failure-e2e-" },
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

  it.each([
    {
      name: "the search query is missing",
      args: ["plugins", "search", "--json"],
      message: "Usage: openclaw plugins search <query>",
    },
    {
      name: "ClawHub transport fails",
      args: ["plugins", "search", "fixture", "--json"],
      message: "offline fixture",
    },
  ])("returns one canonical JSON document when plugins $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
        )}`;
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--import=${preload}`,
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          CLAWHUB_CONFIG_PATH: path.join(tempHome, "missing-clawhub.json"),
          CLAWHUB_TOKEN: "",
          CLAWHUB_AUTH_TOKEN: "",
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toBe("");
        expect(result.stdout).not.toMatch(/[\u001B\u0007]/u);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: testCase.message,
          },
        });
        expect(result.stderr).toContain(testCase.message);
      },
      { prefix: "openclaw-plugins-json-failure-e2e-" },
    );
  });

  it("keeps plugins search JSON failures clean through dual-TTY finalization", async () => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const result = runBuiltCli(tempHome, ["plugins", "search", "--json"], {
          NODE_OPTIONS: `--import=${preload}`,
        });

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Usage: openclaw plugins search <query>",
          },
        });
        expect(result.stdout).not.toMatch(/[\u001B\u0007]/u);
        expect(result.stderr).toContain("Usage: openclaw plugins search <query>");
        expect(result.stderr).toContain("\u001B[?25h");
      },
      { prefix: "openclaw-plugins-json-tty-failure-e2e-" },
    );
  });

  it.each([
    { name: "a missing local marketplace", source: "local" },
    {
      name: "a missing local marketplace through forced Commander",
      source: "local",
      commander: true,
    },
    { name: "a missing local marketplace with dual TTYs", source: "local", tty: true },
    { name: "an unavailable Git marketplace", source: "git" },
    { name: "an unavailable Git marketplace with dual TTYs", source: "git", tty: true },
    { name: "a missing local marketplace in human mode", source: "local", human: true },
    { name: "an unavailable Git marketplace in human mode", source: "git", human: true },
  ])("keeps $name failures on the canonical marketplace output boundary", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const source =
          testCase.source === "git"
            ? "ssh://marketplace.invalid/openclaw/unavailable.git"
            : path.join(tempHome, "missing-marketplace");
        const ttyPreload = Buffer.from(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        ).toString("base64");

        await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });

        const result = runBuiltCli(
          tempHome,
          ["plugins", "marketplace", "list", source, ...("human" in testCase ? [] : ["--json"])],
          {
            GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
            GIT_TERMINAL_PROMPT: "0",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: stateDir,
            ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
            ...("tty" in testCase
              ? { NODE_OPTIONS: `--import=data:text/javascript;base64,${ttyPreload}` }
              : {}),
          },
          { inheritEnvironment: false },
        );
        const expectedMessage =
          testCase.source === "git"
            ? `failed to clone marketplace source ${source}:`
            : `unsupported marketplace source: ${source}`;

        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(expectedMessage);

        if ("human" in testCase) {
          if (testCase.source === "git") {
            expect(result.stdout).toContain(`Cloning marketplace source ${source}...`);
          }
        } else {
          expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
          expect(result.stdout).not.toContain("Cloning marketplace source");
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: {
              type: "cli_error",
              message:
                testCase.source === "git"
                  ? expect.stringContaining(expectedMessage)
                  : expectedMessage,
            },
          });
          if ("tty" in testCase) {
            expect(result.stderr).toContain("\u001B[?25h");
          }
        }

        if (testCase.source === "git") {
          expect(result.stderr).toContain("fatal: Could not read from remote repository.");
          const clonePath = /Cloning into '([^']+)'\.\.\./u.exec(result.stderr)?.[1];
          expect(clonePath).toBeDefined();
          await expect(fs.stat(path.dirname(clonePath as string))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }

        await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(tempHome, ".claude"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-marketplace-json-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "search with a leaf JSON flag",
      args: ["skills", "search", "fixture", "--json"],
      message: "ClawHub /api/v1/search failed (400): offline fixture",
    },
    {
      name: "search with a parent JSON flag",
      args: ["skills", "--json", "search", "fixture"],
      message: "ClawHub /api/v1/search failed (400): offline fixture",
    },
    {
      name: "list with a leaf JSON flag",
      args: ["skills", "list", "--agent", "", "--json"],
      message: "--agent must not be blank",
    },
    {
      name: "list with a parent JSON flag",
      args: ["skills", "--json", "list", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "info with a leaf JSON flag",
      args: ["skills", "info", "fixture", "--agent", "", "--json"],
      message: "--agent must not be blank",
    },
    {
      name: "info with a parent JSON flag",
      args: ["skills", "--json", "info", "fixture", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "check with a leaf JSON flag",
      args: ["skills", "check", "--agent", "", "--json"],
      message: "--agent must not be blank",
    },
    {
      name: "check with a parent JSON flag",
      args: ["skills", "--json", "check", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "the default report after its agent flag",
      args: ["skills", "--agent", "", "--json"],
      message: "--agent must not be blank",
    },
    {
      name: "the default report before its agent flag",
      args: ["skills", "--json", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "list with a configured remote Gateway missing its URL",
      args: ["skills", "list", "--json"],
      message: "gateway remote mode misconfigured: gateway.remote.url missing",
      remoteMissing: true,
    },
    ...[
      { name: "the default report", args: ["skills", "--json"] },
      { name: "list", args: ["skills", "list", "--json"] },
      { name: "info", args: ["skills", "info", "fixture", "--json"] },
      { name: "check", args: ["skills", "check", "--json"] },
      { name: "curator status", args: ["skills", "curator", "status", "--json"] },
      { name: "curator pin", args: ["skills", "curator", "pin", "fixture", "--json"] },
      { name: "curator unpin", args: ["skills", "curator", "unpin", "fixture", "--json"] },
      { name: "curator restore", args: ["skills", "curator", "restore", "fixture", "--json"] },
      {
        name: "workshop apply",
        args: ["skills", "workshop", "apply", "fixture-proposal", "--json"],
      },
    ].map(({ name, args }) => ({
      name: `${name} after an explicit environment Gateway fails`,
      args,
      message: "AUTOQA_SELECTED_GATEWAY_FAILURE",
      explicitGateway: true,
    })),
    {
      name: "curator mutation",
      args: ["skills", "curator", "pin", "missing-skill", "--json"],
      message: "Curated skill not found: missing-skill",
    },
    {
      name: "curator mutation with parent JSON",
      args: ["skills", "curator", "--json", "pin", "missing-skill"],
      message: "Curated skill not found: missing-skill",
    },
    {
      name: "workshop workspace validation with parent JSON",
      args: ["skills", "--json", "workshop", "list", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "workshop mutation",
      args: ["skills", "workshop", "reject", "missing-proposal", "--json"],
      message: "Skill proposal not found: missing-proposal",
    },
    {
      name: "workshop inspection",
      args: ["skills", "workshop", "inspect", "missing-proposal", "--json"],
      message: "Skill proposal not found: missing-proposal",
    },
  ])("returns one canonical JSON document when skills $name fails", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        if ("remoteMissing" in testCase) {
          await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "remote" } }));
        }
        const preload = `data:text/javascript,${encodeURIComponent(
          [
            'globalThis.fetch = async () => new Response("offline fixture", { status: 400 });',
            ...("explicitGateway" in testCase
              ? [
                  'import net from "node:net";',
                  'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_SELECTED_GATEWAY_FAILURE"); };',
                ]
              : []),
          ].join("\n"),
        )}`;
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--import=${preload}`,
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_PORT: "1",
          ...("explicitGateway" in testCase
            ? {
                OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9",
                OPENCLAW_GATEWAY_TOKEN: "fixture-token",
              }
            : {}),
        });
        const message =
          "remoteMissing" in testCase
            ? [
                testCase.message,
                `Config: ${configPath}`,
                "Fix: set gateway.remote.url, or set gateway.mode=local.",
              ].join("\n")
            : testCase.message;

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message,
          },
        });
        expect(result.stderr).toContain(message);
        expect(result.stderr.length).toBeLessThan(2_048);
      },
      { prefix: "openclaw-skills-json-failure-e2e-" },
    );
  });

  it.each([
    { name: "off", debug: "0", includesCause: false },
    { name: "on", debug: "1", includesCause: true },
  ])("keeps skills search nested causes behind debug mode ($name)", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'globalThis.fetch = async () => new Response("not-json", { status: 200 });',
        )}`;
        const result = runBuiltCli(tempHome, ["skills", "search", "fixture"], {
          NODE_OPTIONS: `--import=${preload}`,
          OPENCLAW_DEBUG: testCase.debug,
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("ClawHub /api/v1/search returned malformed JSON");
        expect(result.stderr.includes("Unexpected token")).toBe(testCase.includesCause);
      },
      { prefix: "openclaw-skills-human-failure-e2e-" },
    );
  });

  it("returns one canonical document when docs search fails", async () => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
        )}`;
        const result = runBuiltCli(tempHome, ["docs", "offline", "--json"], {
          NODE_OPTIONS: `--import=${preload}`,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Docs search failed: offline fixture",
          },
        });
        expect(result.stderr).toContain("Docs search failed: offline fixture");
      },
      { prefix: "openclaw-docs-json-failure-e2e-" },
    );
  });

  it("keeps Commander parse failures machine-readable in JSON mode", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, [
          "config",
          "get",
          "gateway.port",
          "--json",
          "--not-a-real-option",
        ]);

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { type: string; message: string };
        };
        expect(payload).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("--not-a-real-option"),
          },
        });
        expect(payload.error.message).not.toMatch(/^error:/i);
        expect(result.stderr).toContain("--not-a-real-option");
      },
      { prefix: "openclaw-json-parse-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "unknown root",
      args: ["pairng"],
      diagnostic: 'OpenClaw does not know the command "pairng".',
      suggestion: "openclaw pairing",
    },
    {
      name: "unknown nested command",
      args: ["sessions", "lst"],
      diagnostic: 'OpenClaw sessions has no command "lst".',
      suggestion: "openclaw sessions list",
    },
    {
      name: "unknown nested command with a later argument",
      args: ["config", "gett", "gateway.port"],
      diagnostic: 'OpenClaw config has no command "gett".',
      suggestion: "openclaw config get",
    },
    {
      name: "unknown root before help",
      args: ["pairng", "--help"],
      diagnostic: 'OpenClaw does not know the command "pairng".',
      suggestion: "openclaw pairing",
    },
  ])("renders $name as actionable guidance", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, testCase.args);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(testCase.diagnostic);
        expect(result.stderr).toContain(`Did you mean this?\n  ${testCase.suggestion}`);
        expect(result.stderr.split(testCase.diagnostic)).toHaveLength(2);
        expect(result.stderr.split(testCase.suggestion)).toHaveLength(2);
        expect(result.stderr).not.toContain("The CLI command failed.");
        expect(result.stderr).not.toContain("Could not start the CLI.");
        expect(result.stderr).not.toContain("OPENCLAW_DEBUG");
        expect(result.stderr).not.toContain("openclaw doctor");
        if (testCase.args.includes("--help")) {
          expect(result.stdout).not.toContain("Usage: openclaw [options] [command]");
        }
      },
      { prefix: "openclaw-unknown-command-e2e-" },
    );
  });

  it.each([
    {
      name: "unknown root",
      args: ["pairng", "--json"],
      diagnostic: 'OpenClaw does not know the command "pairng".',
      suggestion: "openclaw pairing",
    },
    {
      name: "unknown nested command",
      args: ["sessions", "lst", "--json"],
      diagnostic: 'OpenClaw sessions has no command "lst".',
      suggestion: "openclaw sessions list",
    },
  ])("reports $name once with structured JSON guidance", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, testCase.args);

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { type: string; message: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error.type).toBe("cli_error");
        expect(payload.error.message).toContain(testCase.diagnostic);
        expect(payload.error.message).not.toMatch(/^error:/i);
        expect(payload.error.message).toContain(`Did you mean this?\n  ${testCase.suggestion}`);
        expect(payload.error.message).not.toContain("OPENCLAW_DEBUG");
        expect(payload.error.message).not.toContain("openclaw doctor");
        expect(result.stderr).toContain(testCase.diagnostic);
        expect(result.stderr).toContain(`Did you mean this?\n  ${testCase.suggestion}`);
        expect(result.stderr.split(testCase.diagnostic)).toHaveLength(2);
        expect(result.stderr.split(testCase.suggestion)).toHaveLength(2);
        expect(result.stderr).not.toContain("The CLI command failed.");
        expect(result.stderr).not.toContain("Could not start the CLI.");
        expect(result.stderr).not.toContain("OPENCLAW_DEBUG");
        expect(result.stderr).not.toContain("openclaw doctor");
      },
      { prefix: "openclaw-unknown-command-json-e2e-" },
    );
  });

  it("keeps parse-error JSON free of terminal controls when color is forced", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, ["sessions", "lst", "--json"], {
          FORCE_COLOR: "1",
        });

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          error: { message: string };
        };
        expect(payload.error.message).toBe(
          'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli',
        );
        expect(payload.error.message).not.toMatch(/[\u001B\u0007]/u);
        expect(result.stdout).not.toContain("\\u001b");
        expect(result.stderr).toContain("\u001B[");
      },
      { prefix: "openclaw-unknown-command-color-json-e2e-" },
    );
  });

  it("keeps representative success payload bytes unchanged", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        await fs.writeFile(configPath, '{"gateway":{"port":28789}}\n', "utf8");
        const env = { OPENCLAW_CONFIG_PATH: configPath };

        const getResult = runBuiltCli(tempHome, ["config", "get", "gateway.port", "--json"], env);
        const validateResult = runBuiltCli(tempHome, ["config", "validate", "--json"], env);

        expect(getResult.status, getResult.stderr).toBe(0);
        expect(getResult.stdout).toBe("28789\n");
        expect(validateResult.status, validateResult.stderr).toBe(0);
        expect(validateResult.stdout).toBe(
          `${JSON.stringify({ valid: true, path: configPath, warnings: [] })}\n`,
        );
      },
      { prefix: "openclaw-json-success-bytes-e2e-" },
    );
  });

  it("keeps `config schema` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, ["config", "schema"], {
          OPENCLAW_LOG_LEVEL: "debug",
        });

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as {
          properties?: Record<string, unknown>;
        };
        expect(parsed.properties?.$schema).toEqual({ type: "string" });
        expect(result.stdout).not.toContain("possibly sensitive key found");
        expect(result.stderr).not.toContain("possibly sensitive key found");
      },
      { prefix: "openclaw-config-schema-json-e2e-" },
    );
  });

  it("keeps `config validate --json` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        await fs.writeFile(configPath, "{}", "utf8");
        const result = runBuiltCli(tempHome, ["config", "validate", "--json"], {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_LOG_LEVEL: "debug",
        });

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          valid: true,
          path: configPath,
        });
        expect(result.stdout).not.toContain("possibly sensitive key found");
      },
      { prefix: "openclaw-config-validate-json-e2e-" },
    );
  });

  it("returns structured Doctor lint output when llama.cpp is not bundled", async () => {
    await withTempHome(
      async (tempHome) => {
        const bundledPluginsDir = path.join(tempHome, "packaged-extensions");
        const memoryCoreDir = path.join(bundledPluginsDir, "memory-core");
        await fs.mkdir(memoryCoreDir, { recursive: true });
        await fs.writeFile(
          path.join(memoryCoreDir, "doctor-health-api.js"),
          [
            "export function registerMemoryCoreDoctorChecks(host) {",
            "  host.registerHealthCheck({",
            '    id: "memory-core/managed-local-embedding-setup",',
            '    kind: "plugin",',
            '    source: "memory-core",',
            '    description: "packaged Memory Core readiness fixture",',
            "    async detect() { return []; },",
            "  });",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = runBuiltCli(
          tempHome,
          [
            "doctor",
            "--lint",
            "--only",
            "memory-core/managed-local-embedding-setup",
            "--severity-min",
            "error",
            "--json",
          ],
          {
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          checksRun: 1,
          findings: [],
        });
      },
      { prefix: "openclaw-doctor-packaged-json-e2e-" },
    );
  });
});
