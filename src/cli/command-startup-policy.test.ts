// Command startup policy tests cover which CLI commands require startup side effects.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliCommandCatalog } from "./command-catalog.js";
import { resolveCliExecutionStartupContext } from "./command-execution-startup.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

function resolvePolicy(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  return resolveCliStartupPolicy({
    jsonOutputMode: false,
    ...params,
  });
}

describe("command-startup-policy", () => {
  afterEach(() => {
    vi.doUnmock("./command-path-policy.js");
    vi.resetModules();
  });

  it("resolves config guard policy for Commander and invocation-aware commands", () => {
    for (const commandPath of [
      ["backup", "create"],
      ["database"],
      ["config"],
      ["config", "file"],
      ["config", "validate"],
      ["config", "schema"],
      ["docs"],
      ["agent", "exec"],
      ["status"],
      ["agents", "bindings"],
      ["approvals", "pending"],
      ["skills"],
      ["skills", "list"],
      ["skills", "check"],
      ["skills", "info"],
      ["skills", "search"],
      ["hooks"],
      ["hooks", "list"],
      ["hooks", "info"],
      ["hooks", "check"],
      ["memory", "search"],
      ["memory", "status"],
      ["gateway", "stability"],
      ["gateway", "usage-cost"],
    ]) {
      expect(resolvePolicy({ commandPath }).skipConfigGuard, commandPath.join(" ")).toBe(true);
    }
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }).skipConfigGuard,
    ).toBe(true);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
      }).skipConfigGuard,
    ).toBe(false);
    expect(resolvePolicy({ commandPath: ["config", "set"] }).skipConfigGuard).toBe(false);
    for (const flag of ["--index", "--fix"]) {
      expect(
        resolvePolicy({
          argv: ["node", "openclaw", "memory", "status", flag],
          commandPath: ["memory", "status"],
        }).skipConfigGuard,
      ).toBe(false);
    }
  });

  it("keeps gateway-owned mutations on non-observing config validation", () => {
    for (const commandPath of [
      ["nodes", "approve"],
      ["nodes", "remove"],
      ["devices", "approve"],
      ["devices", "remove"],
      ["gateway", "call"],
      ["gateway", "restart"],
      ["gateway", "suspend"],
      ["gateway", "resume"],
    ]) {
      expect(resolvePolicy({ commandPath })).toMatchObject({
        skipConfigGuard: false,
        validateConfigOnly: true,
      });
    }
  });

  it("skips operator-state startup for local Claw authoring commands only", () => {
    for (const subcommand of ["create", "validate", "build", "dev"]) {
      const commandPath = ["claws", subcommand];
      expect(resolvePolicy({ commandPath }).skipConfigGuard, commandPath.join(" ")).toBe(true);
    }
    for (const subcommand of ["add", "update", "remove"]) {
      const commandPath = ["claws", subcommand];
      expect(resolvePolicy({ commandPath }).skipConfigGuard, commandPath.join(" ")).toBe(false);
    }
  });

  it("defers startup migrations for every update invocation", () => {
    for (const testCase of [
      { argv: ["node", "openclaw", "update"], commandPath: ["update"] },
      { argv: ["node", "openclaw", "--update"], commandPath: ["update"] },
      {
        argv: ["node", "openclaw", "--profile", "work", "update"],
        commandPath: ["update"],
      },
      {
        argv: ["node", "openclaw", "update", "--dry-run"],
        commandPath: ["update"],
      },
      {
        argv: ["node", "openclaw", "update", "status"],
        commandPath: ["update", "status"],
      },
      {
        argv: ["node", "openclaw", "update", "repair"],
        commandPath: ["update", "repair"],
      },
      {
        argv: ["node", "openclaw", "update", "finalize"],
        commandPath: ["update", "finalize"],
      },
      {
        argv: ["node", "openclaw", "update", "wizard"],
        commandPath: ["update", "wizard"],
      },
    ]) {
      expect(resolvePolicy(testCase).skipConfigGuard, testCase.argv.join(" ")).toBe(true);
    }
  });

  it("keeps every route-first command on the same config guard declaration as Commander", () => {
    for (const entry of cliCommandCatalog.filter((candidate) => candidate.route)) {
      expect(entry.policy?.configGuard, entry.commandPath.join(" ")).toBeDefined();
      for (const jsonOutputMode of [false, true]) {
        const argv = ["node", "openclaw", ...entry.commandPath];
        const expectedSkip = entry.commandPath.join(" ") !== "config unset";
        const routed = resolveCliExecutionStartupContext({ argv, jsonOutputMode });
        const commander = resolveCliExecutionStartupContext({
          argv,
          commandPath: [...entry.commandPath],
          jsonOutputMode,
        });
        expect(routed.startupPolicy.skipConfigGuard, entry.commandPath.join(" ")).toBe(
          commander.startupPolicy.skipConfigGuard,
        );
        expect(routed.startupPolicy.skipConfigGuard, entry.commandPath.join(" ")).toBe(
          expectedSkip,
        );
      }
    }
  });

  it("skips when-suppressed guards only for suppressed output", async () => {
    vi.doMock("./command-path-policy.js", () => ({
      resolveCliCommandPathPolicy: () => ({
        configGuard: "when-suppressed",
        loadPlugins: "never",
        pluginRegistry: { scope: "all" },
        ownsProtocolStdout: false,
        hideBanner: false,
        ensureCliPath: true,
        networkProxy: "default",
      }),
    }));
    const { resolveCliStartupPolicy: resolveWithSuppressedGuard } = await importFreshModule<
      typeof import("./command-startup-policy.js")
    >(import.meta.url, "./command-startup-policy.js?when-suppressed");

    expect(
      resolveWithSuppressedGuard({ commandPath: ["test"], jsonOutputMode: false }).skipConfigGuard,
    ).toBe(false);
    expect(
      resolveWithSuppressedGuard({ commandPath: ["test"], jsonOutputMode: true }).skipConfigGuard,
    ).toBe(true);
  });

  it("matches plugin preload policy", () => {
    for (const commandPath of [
      ["memory", "index"],
      ["memory", "search"],
      ["memory", "status"],
    ]) {
      const policy = resolvePolicy({ commandPath });
      expect(policy.loadPlugins, commandPath.join(" ")).toBe(true);
      expect(policy.pluginRegistry, commandPath.join(" ")).toEqual({ scope: "memory" });
    }
    expect(
      resolvePolicy({
        commandPath: ["status"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["health"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "status"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "list"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "add"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "logs"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["message", "send"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["message", "send"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--json"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--json", "--local"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(true);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "exec", "fix it"],
        commandPath: ["agent", "exec"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "list"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "list"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "bind"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "bindings"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "unbind"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "set-identity"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "delete"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
  });

  it("matches banner suppression policy", () => {
    expect(resolvePolicy({ commandPath: ["update", "status"], env: {} }).hideBanner).toBe(true);
    expect(resolvePolicy({ commandPath: ["completion"], env: {} }).hideBanner).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        env: {
          ...process.env,
          OPENCLAW_HIDE_BANNER: "1",
        },
      }).hideBanner,
    ).toBe(true);
    expect(resolvePolicy({ commandPath: ["status"], env: {} }).hideBanner).toBe(false);
  });

  it("uses process env banner suppression when startup env is omitted", () => {
    const originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    try {
      process.env.OPENCLAW_HIDE_BANNER = "1";

      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
        }).hideBanner,
      ).toBe(true);
      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
          env: {},
        }).hideBanner,
      ).toBe(false);
    } finally {
      if (originalHideBanner === undefined) {
        delete process.env.OPENCLAW_HIDE_BANNER;
      } else {
        process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
      }
    }
  });

  it("aggregates startup policy for both dispatch paths", () => {
    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        env: {},
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: true,
      loadPlugins: false,
      pluginRegistry: { scope: "channels" },
    });
  });

  it("suppresses startup stdout for the mcp serve protocol", () => {
    expect(resolvePolicy({ commandPath: ["mcp", "serve"] }).suppressDoctorStdout).toBe(true);
  });

  it("reserves stdout for the browser native-host protocol", () => {
    const policy = resolvePolicy({ commandPath: ["browser", "extension", "native-host"] });

    expect(policy.hideBanner).toBe(true);
    expect(policy.suppressDoctorStdout).toBe(true);
  });

  it("reserves stdout for the node worker protocol", () => {
    const policy = resolvePolicy({ commandPath: ["node", "worker"] });

    expect(policy.hideBanner).toBe(true);
    expect(policy.loadPlugins).toBe(false);
    expect(policy.suppressDoctorStdout).toBe(true);
  });

  it("isolates cloud worker startup", () => {
    const policy = resolvePolicy({ commandPath: ["worker"] });

    expect(policy.skipConfigGuard).toBe(true);
    expect(policy.hideBanner).toBe(true);
    expect(policy.loadPlugins).toBe(false);
    expect(policy.suppressDoctorStdout).toBe(true);
  });

  it("suppresses startup stdout for the bare acp protocol", () => {
    expect(resolvePolicy({ commandPath: ["acp"] }).suppressDoctorStdout).toBe(true);
  });

  it("keeps startup stdout for non-protocol commands", () => {
    expect(resolvePolicy({ commandPath: ["mcp", "list"] }).suppressDoctorStdout).toBe(false);
    expect(resolvePolicy({ commandPath: ["acp", "client"] }).suppressDoctorStdout).toBe(false);
    expect(resolvePolicy({ commandPath: ["status"] }).suppressDoctorStdout).toBe(false);
  });
});
