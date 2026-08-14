import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFixture,
  runGateway,
  runGatewayUntilFile,
  runPreflight,
  snapshotTree,
} from "./gateway-preflight.process.test-support.js";

export function registerGatewayPreflightCoreProcessTests(): void {
  describe("gateway preflight CLI core process", () => {
    it.each([
      {
        name: "missing config",
        config: {},
        removeConfig: true,
        message: "Missing config.",
      },
      {
        name: "missing gateway mode",
        config: { memory: { search: { provider: "none" } } },
        removeConfig: false,
        message: "existing config is missing gateway.mode",
      },
      {
        name: "non-local gateway mode",
        config: {
          gateway: { mode: "remote" },
          memory: { search: { provider: "none" } },
        },
        removeConfig: false,
        message: "set gateway.mode=local",
      },
    ])("blocks $name in agreement with direct Gateway startup", async (testCase) => {
      const fixture = await createFixture({
        config: testCase.config,
        includeFixturePlugin: false,
        includeSharedStateDatabase: false,
      });
      if (testCase.removeConfig) {
        await fs.rm(fixture.configPath);
      }
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "blocked",
        blockers: [
          expect.objectContaining({
            code: "gateway-start-config-blocked",
            message: expect.stringContaining(testCase.message),
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).toBe(78);
      expect(startup.stderr).toContain(testCase.message);
    });

    it("blocks the same missing password prerequisite as direct Gateway startup", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local", auth: { mode: "password" } },
          memory: { search: { provider: "none" } },
        },
      });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: false,
        status: "blocked",
        blockers: [
          {
            id: "core/gateway-auth/password-missing",
            pluginId: "core",
            migrationId: "gateway-auth",
            code: "gateway-password-missing",
            configPath: "gateway.auth.password",
          },
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).toBe(78);
      expect(startup.stderr).toContain(
        "Gateway auth is set to password, but no password is configured.",
      );
    });

    it("blocks the same ambiguous auth mode prerequisite as direct Gateway startup", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: {
              token: "configured-token",
              password: "configured-password",
            },
          },
          memory: { search: { provider: "none" } },
        },
      });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: false,
        status: "blocked",
        blockers: [
          {
            id: "core/gateway-auth/explicit-mode-required",
            pluginId: "core",
            migrationId: "gateway-auth",
            code: "gateway-auth-mode-required",
            message: expect.stringMatching(/gateway\.auth\.mode is unset/i),
            configPath: "gateway.auth.mode",
          },
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).toBe(1);
      expect(startup.stderr).toContain(
        "gateway.auth.token and gateway.auth.password are both configured",
      );
    });

    it("accepts password inputs already present in config or the target environment", async () => {
      const configured = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "password", password: "configured-password" },
          },
          memory: { search: { provider: "none" } },
        },
      });
      const environment = await createFixture({
        config: {
          gateway: { mode: "local", auth: { mode: "password" } },
          memory: { search: { provider: "none" } },
        },
      });

      const results = [
        await runPreflight(configured),
        await runPreflight(environment, {
          OPENCLAW_GATEWAY_PASSWORD: "environment-password",
        }),
      ];

      for (const result of results) {
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          status: "ready",
          blockers: [],
          errors: [],
        });
      }
    });

    it("returns indeterminate for active auth refs without resolving them", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: {
              mode: "password",
              password: { source: "env", provider: "default", id: "GW_PASSWORD" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          memory: { search: { provider: "none" } },
        },
      });
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(fixture, {
        GW_PASSWORD: "preflight-must-not-resolve-this",
      });

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        status: "indeterminate",
        blockers: [],
        errors: [
          {
            id: "core/gateway-auth",
            pluginId: "core",
            migrationId: "gateway-auth",
            code: "credential-inspection-required",
            message: expect.stringContaining("gateway.auth.password"),
          },
        ],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });

    it("does not execute a login shell when fallback could change startup inputs", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local" },
          env: { shellEnv: { enabled: true } },
          memory: { search: { provider: "none" } },
        },
      });
      const shellSentinel = path.join(fixture.root, "shell-ran");
      await fs.writeFile(
        path.join(fixture.root, ".profile"),
        [
          'export OPENCLAW_GATEWAY_TOKEN="validator-shell-token"',
          'printf shell-ran > "$OPENCLAW_SHELL_SENTINEL"',
          "",
        ].join("\n"),
      );
      const before = await snapshotTree(fixture.root);
      const env = {
        OPENCLAW_SHELL_SENTINEL: shellSentinel,
        SHELL: "/bin/sh",
      };

      const preflight = await runPreflight(fixture, env);

      expect(preflight.code).toBe(2);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [
          expect.objectContaining({
            code: "gateway-shell-env-inspection-required",
            message: expect.stringContaining("OPENCLAW_GATEWAY_TOKEN"),
          }),
        ],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
      await expect(fs.access(shellSentinel)).rejects.toThrow();

      await expect(runGatewayUntilFile(fixture, env, shellSentinel, 90_000)).resolves.toBe(
        "shell-ran",
      );
    }, 120_000);

    it("does not require or execute shell fallback when config fixes Gateway auth", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "validator-explicit-token" },
          },
          env: { shellEnv: { enabled: true } },
          memory: { search: { provider: "none" } },
        },
      });
      const shellSentinel = path.join(fixture.root, "shell-ran");
      await fs.writeFile(
        path.join(fixture.root, ".profile"),
        [
          'export OPENCLAW_GATEWAY_TOKEN="validator-shell-token"',
          'printf shell-ran > "$OPENCLAW_SHELL_SENTINEL"',
          "",
        ].join("\n"),
      );
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture, {
        OPENCLAW_SHELL_SENTINEL: shellSentinel,
        SHELL: "/bin/sh",
      });

      expect(preflight.code).toBe(0);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: true,
        status: "ready",
        blockers: [],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
      await expect(fs.access(shellSentinel)).rejects.toThrow();
    });

    it("keeps token bootstrap, auth disablement, and inactive refs ready", async () => {
      const fixtures = [
        await createFixture({
          config: {
            gateway: {
              mode: "local",
              auth: {
                mode: "token",
                password: { source: "env", provider: "default", id: "INACTIVE_PASSWORD" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            memory: { search: { provider: "none" } },
          },
        }),
        await createFixture({
          config: {
            gateway: { mode: "local", auth: { mode: "none" } },
            memory: { search: { provider: "none" } },
          },
        }),
      ];

      for (const fixture of fixtures) {
        const result = await runPreflight(fixture);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          status: "ready",
          blockers: [],
          errors: [],
        });
      }
    });

    it("blocks the same known-weak credential as direct Gateway startup", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "change-me-now",
            },
          },
          memory: { search: { provider: "none" } },
        },
      });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);
      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "blocked",
        blockers: [expect.objectContaining({ code: "gateway-auth-known-weak" })],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toMatch(/example placeholder/i);
    });

    it("blocks the same unauthenticated LAN bind as direct Gateway startup", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local", bind: "lan", auth: { mode: "none" } },
          memory: { search: { provider: "none" } },
        },
      });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);
      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "blocked",
        blockers: [expect.objectContaining({ code: "gateway-bind-auth-required" })],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).toBe(78);
      expect(startup.stderr).toContain("Refusing to bind gateway to lan without auth.");
    });

    it.each([
      {
        name: "trusted-proxy auth without a proxy list",
        config: {
          gateway: {
            mode: "local",
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
          memory: { search: { provider: "none" } },
        },
        code: "gateway-trusted-proxies-required",
        startupMessage:
          "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      },
      {
        name: "Tailscale Funnel with token auth",
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "configured-token" },
            tailscale: { mode: "funnel" },
          },
          memory: { search: { provider: "none" } },
        },
        code: "gateway-tailscale-funnel-password-required",
        startupMessage: "tailscale funnel requires gateway auth mode=password",
      },
    ])("blocks $name in agreement with direct Gateway startup", async (testCase) => {
      const fixture = await createFixture({ config: testCase.config });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "blocked",
        blockers: [
          expect.objectContaining({
            id: `core/gateway-runtime/${testCase.code}`,
            code: testCase.code,
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toContain(testCase.startupMessage);
    });

    it("keeps runtime-seeded non-loopback Control UI origins ready and mutation-free", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            bind: "lan",
            auth: { mode: "token", token: "configured-token" },
          },
          memory: { search: { provider: "none" } },
        },
      });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);

      expect(preflight.code).toBe(0);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: true,
        status: "ready",
        blockers: [],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });

    it("never opens a listener while classifying a probe-dependent bind", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local", bind: "auto", auth: { mode: "none" } },
          memory: { search: { provider: "none" } },
        },
      });
      const observerPath = path.join(fixture.root, "observe-listen.cjs");
      const listenLog = path.join(fixture.root, "listen-events.jsonl");
      await fs.writeFile(
        observerPath,
        [
          'const fs = require("node:fs");',
          'const net = require("node:net");',
          "const original = net.createServer;",
          "net.createServer = function (...args) {",
          "  const server = original.apply(this, args);",
          "  const listen = server.listen;",
          "  server.listen = function (...listenArgs) {",
          '    fs.appendFileSync(process.env.OPENCLAW_LISTEN_OBSERVER, JSON.stringify(listenArgs) + "\\n");',
          "    return listen.apply(this, listenArgs);",
          "  };",
          "  return server;",
          "};",
          "",
        ].join("\n"),
      );
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(fixture, {
        NODE_OPTIONS: `--require=${observerPath}`,
        OPENCLAW_LISTEN_OBSERVER: listenLog,
      });

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [expect.objectContaining({ code: "gateway-bind-inspection-required" })],
      });
      await expect(fs.access(listenLog)).rejects.toThrow();
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });

    it("returns indeterminate for protected memory credentials in a SecretRef", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local" },
          memory: {
            search: {
              provider: "openai",
              fallback: "none",
              model: "text-embedding-3-small",
              remote: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        },
        disableMemorySlot: false,
        vectorModel: "text-embedding-3-small",
      });
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(fixture, {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENAI_API_KEY: "preflight-must-not-resolve-this",
      });

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: expect.arrayContaining([
          expect.objectContaining({
            code: "inspection-indeterminate",
            message: expect.stringContaining("Memory provider credentials use a SecretRef"),
          }),
        ]),
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });

    it("reports a startup-blocking unreadable session store without mutation", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local" },
          memory: { search: { provider: "none" } },
        },
        invalidSessionStore: true,
      });
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(fixture);

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        status: "blocked",
        blockers: [
          expect.objectContaining({
            id: "core/session-sqlite/main/store_unreadable/1",
            pluginId: "core",
            migrationId: "session-sqlite",
            code: "store_unreadable",
            agentId: "main",
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });
  });
}
