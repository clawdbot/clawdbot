import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  describe.each([
    { context: "ordinary fresh home", env: {}, reason: "never-asked" },
    { context: "automated fresh home", env: { CI: "1" }, reason: "automated-environment" },
    {
      context: "automation with an explicit endpoint",
      env: {
        CI: "1",
        OPENCLAW_TELEMETRY_ENDPOINT: "https://telemetry.example.invalid/api/latest-version",
      },
      reason: "never-asked",
    },
  ])("telemetry inspection in $context", ({ env, reason }) => {
    it.each([
      { name: "piped stdout", tty: false, format: "JSON" },
      { name: "stubbed dual TTYs", tty: true, format: "JSON" },
      { name: "piped stdout", tty: false, format: "text" },
      { name: "stubbed dual TTYs", tty: true, format: "text" },
    ])("writes successful telemetry show $format to $name", async ({ tty, format }) => {
      await withTempHome(
        async (tempHome) => {
          const preload = Buffer.from(
            [
              'import net from "node:net";',
              'const denyNetwork = () => { throw new Error("TELEMETRY_NETWORK_FORBIDDEN"); };',
              "net.Socket.prototype.connect = denyNetwork;",
              "globalThis.fetch = async () => denyNetwork();",
              ...(tty
                ? [
                    'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                    'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                  ]
                : []),
            ].join("\n"),
          ).toString("base64");
          // CI and the endpoint are named inputs, independent of the test runner's environment.
          const result = runBuiltCli(
            tempHome,
            ["telemetry", "show", ...(format === "JSON" ? ["--json"] : [])],
            {
              ...env,
              NODE_OPTIONS: `--import=data:text/javascript;base64,${preload}`,
              OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
              OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
              ...(tty ? { FORCE_COLOR: "1" } : {}),
            },
            { inheritEnvironment: false },
          );

          expect(result.status, result.stderr).toBe(0);
          const endpoint =
            env.OPENCLAW_TELEMETRY_ENDPOINT ?? "https://telemetry.openclaw.ai/api/latest-version";
          if (format === "JSON") {
            expect(result.stdout, result.stderr).not.toContain("\u001B");
            expect(result.stdout, result.stderr).not.toContain("\u0007");
            const payload = JSON.parse(result.stdout);
            expect(payload).toEqual({
              featureStatsEnabled: false,
              reason,
              endpoint,
              lastPingAt: null,
              request:
                reason === "automated-environment"
                  ? null
                  : {
                      method: "GET",
                      userAgent: expect.stringMatching(/^openclaw\/[^ ]+ \(.+; gateway\)$/u),
                    },
            });
            expect(result.stdout).toBe(`${JSON.stringify(payload)}\n`);
          } else {
            // Human TTY output includes the startup banner before the inspection report.
            const report = result.stdout.slice(result.stdout.indexOf("Feature stats:"));
            const lines = report.trimEnd().split("\n");
            expect(lines).toEqual([
              "Feature stats: disabled",
              `Reason: ${reason === "automated-environment" ? "disabled in an automated environment (CI is set)" : "consent has not been requested"}`,
              `Endpoint: ${endpoint}`,
              "Last ping: never",
              ...(reason === "automated-environment"
                ? ["Request: none (disabled in an automated environment (CI is set))"]
                : [
                    `Request: GET ${endpoint}`,
                    expect.stringMatching(/^User-Agent: openclaw\/[^ ]+ \(.+; gateway\)$/u),
                  ]),
            ]);
          }
          if (tty && format === "text") {
            expect(result.stdout).toContain("OpenClaw");
            expect(result.stderr).toContain("\u001B[?25h");
            expect(result.stderr).not.toContain("TELEMETRY_NETWORK_FORBIDDEN");
          } else {
            expect(result.stderr).toBe("");
          }
        },
        { prefix: "openclaw-telemetry-json-success-e2e-" },
      );
    });
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
            expect(result.stdout, result.stderr).not.toContain("\u001B");
            expect(result.stdout, result.stderr).not.toContain("\u0007");
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

  it.each(["probe", "diagnostics"])(
    "keeps the CLI alive until stalled channel capability %s reports its timeout",
    async (stage) => {
      await withTempHome(
        async (tempHome) => {
          const pluginDir = path.join(tempHome, "capability-plugin");
          const workspace = path.join(tempHome, "workspace");
          await fs.mkdir(pluginDir);
          await fs.mkdir(workspace);
          const id = "capability-fixture";
          const meta = {
            id,
            label: "Capability fixture",
            selectionLabel: "Capability fixture",
            docsPath: "/channels/test",
            blurb: "Synthetic channel",
          };
          const schema = {
            type: "object",
            additionalProperties: false,
            properties: { enabled: { type: "boolean" } },
          };
          await fs.writeFile(
            path.join(pluginDir, "package.json"),
            JSON.stringify({
              name: id,
              version: "1.0.0",
              type: "module",
              openclaw: {
                extensions: ["./index.js"],
                setupEntry: "./index.js",
                channel: meta,
              },
            }),
          );
          await fs.writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id,
              channels: [id],
              configSchema: { type: "object", additionalProperties: false, properties: {} },
              channelConfigs: { [id]: { schema } },
            }),
          );
          await fs.writeFile(
            path.join(pluginDir, "index.js"),
            `export const plugin = {
              id: ${JSON.stringify(id)}, meta: ${JSON.stringify(meta)},
              capabilities: { chatTypes: ["direct"] },
              configSchema: { schema: ${JSON.stringify(schema)} },
              config: {
                listAccountIds: () => ["default"],
                resolveAccount: () => ({ accountId: "default", enabled: true }),
                isConfigured: () => true, isEnabled: () => true,
              },
              status: {
                async probeAccount() { return ${stage === "probe" ? "new Promise(() => {})" : "{ ok: true }"}; },
                async buildCapabilitiesDiagnostics() { return ${stage === "diagnostics" ? "new Promise(() => {})" : "{ lines: [] }"}; },
              },
            };
            export default { id: plugin.id, register(api) { api.registerChannel({ plugin }); } };`,
          );
          const configPath = path.join(tempHome, "openclaw.json");
          await fs.writeFile(
            configPath,
            JSON.stringify({
              agents: { defaults: { workspace } },
              plugins: { load: { paths: [pluginDir] }, entries: { [id]: { enabled: true } } },
              channels: { [id]: { enabled: true } },
              logging: { level: "silent", consoleLevel: "silent" },
            }),
          );

          const result = runBuiltCli(
            tempHome,
            ["channels", "capabilities", "--json", "--timeout", "20"],
            {
              OPENCLAW_CONFIG_PATH: configPath,
              OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
            { inheritEnvironment: false },
          );

          expect(result.status, result.stderr).toBe(0);
          const [report] = JSON.parse(result.stdout).channels;
          expect(report.channel).toBe(id);
          if (stage === "probe") {
            expect(report.probe).toEqual({
              ok: false,
              timedOut: true,
              error: "probe timed out after 20ms",
            });
          } else {
            expect(report.probe).toEqual({ ok: true });
            expect(report.diagnostics).toEqual({
              lines: [{ text: "Diagnostics: timed out after 20ms", tone: "error" }],
              details: { timedOut: true },
            });
          }
        },
        { prefix: "openclaw-capabilities-timeout-e2e-" },
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

  it.each([
    {
      name: "secrets apply",
      args: (tempHome: string) => [
        "secrets",
        "apply",
        "--from",
        path.join(tempHome, "missing-plan.json"),
        "--json",
      ],
      status: 1,
      message: (tempHome: string) =>
        `Secrets plan file not found: ${path.join(tempHome, "missing-plan.json")}`,
    },
    {
      name: "secrets store get",
      args: () => ["secrets", "store", "get", "MISSING_VALUE", "--json"],
      status: 3,
      message: () => 'Secret store entry "MISSING_VALUE" was not found.',
    },
  ])("keeps $name failures machine-readable", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, testCase.args(tempHome), {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
        });

        expect(result.status, result.stderr).toBe(testCase.status);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: { type: "cli_error", message: testCase.message(tempHome) },
        });
        expect(result.stdout).not.toContain("[openclaw]");
      },
      { prefix: "openclaw-secrets-json-failure-e2e-" },
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
        expect(payload.error.message).not.toContain("\u001B");
        expect(payload.error.message).not.toContain("\u0007");
        expect(result.stdout).not.toContain("\\u001b");
        expect(result.stderr).toContain("\u001B[");
      },
      { prefix: "openclaw-unknown-command-color-json-e2e-" },
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
