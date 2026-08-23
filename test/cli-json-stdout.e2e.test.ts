// CLI JSON stdout E2E tests validate machine-readable CLI output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

function runBuiltCli(tempHome: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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

describe("cli json stdout contract", () => {
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
  ])("renders sessions registration validation failures for $name", async (testCase) => {
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
            error: { type: "cli_error", message: testCase.message },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr.split(testCase.message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-sessions-registration-json-failure-e2e-" },
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
  ])("returns one canonical JSON document when skills $name fails", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'globalThis.fetch = async () => new Response("offline fixture", { status: 400 });',
        )}`;
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--import=${preload}`,
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
        });

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: testCase.message,
          },
        });
        expect(result.stderr).toContain(testCase.message);
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
