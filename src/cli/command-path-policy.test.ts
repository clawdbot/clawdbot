// Command path policy tests cover allowed CLI command path shapes and lazy imports.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliCommandCatalogEntry, CliCommandPathPolicy } from "./command-catalog.js";
import {
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "./command-path-policy.js";

const DEFAULT_EXPECTED_POLICY: CliCommandPathPolicy = {
  configGuard: "run",
  loadPlugins: "never",
  pluginRegistry: { scope: "all" },
  ownsProtocolStdout: false,
  hideBanner: false,
  ensureCliPath: true,
  networkProxy: "default",
};

type NetworkProxyResolver = Extract<
  CliCommandPathPolicy["networkProxy"],
  (ctx: { argv: string[]; commandPath: string[] }) => unknown
>;
type LoadPluginsResolver = Extract<
  CliCommandPathPolicy["loadPlugins"],
  (ctx: { argv: string[]; commandPath: string[]; jsonOutputMode: boolean }) => unknown
>;
type ConfigGuardResolver = Extract<
  CliCommandPathPolicy["configGuard"],
  (ctx: { argv: string[]; commandPath: string[] }) => unknown
>;

function expectResolvedPolicy(
  commandPath: string[],
  expected: Partial<CliCommandPathPolicy>,
): void {
  expect(resolveCliCommandPathPolicy(commandPath)).toEqual({
    ...DEFAULT_EXPECTED_POLICY,
    ...expected,
  });
}

function expectNetworkProxyResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & { networkProxy: NetworkProxyResolver } {
  expect(typeof policy.networkProxy).toBe("function");
}

function expectLoadPluginsResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & { loadPlugins: LoadPluginsResolver } {
  expect(typeof policy.loadPlugins).toBe("function");
}

function expectConfigGuardResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & { configGuard: ConfigGuardResolver } {
  expect(typeof policy.configGuard).toBe("function");
}

describe("command-path-policy", () => {
  afterEach(() => {
    vi.doUnmock("./command-catalog.js");
    vi.resetModules();
  });

  it("resolves status policy with shared startup semantics", () => {
    expectResolvedPolicy(["status"], {
      configGuard: "skip",
      loadPlugins: "never",
      pluginRegistry: { scope: "channels" },
      ensureCliPath: false,
      networkProxy: "bypass",
    });
  });

  it("keeps built-in node RPCs off the config guard", () => {
    for (const subcommand of ["status", "list"]) {
      expectResolvedPolicy(["nodes", subcommand], {
        configGuard: "skip",
        networkProxy: "bypass",
      });
    }
    for (const subcommand of [
      "describe",
      "pending",
      "approve",
      "reject",
      "remove",
      "rename",
      "invoke",
      "notify",
      "push",
      "camera",
      "screen",
      "location",
    ]) {
      expectResolvedPolicy(["nodes", subcommand], {
        configGuard: "validate",
        networkProxy: "bypass",
      });
    }
    // Bare `openclaw nodes` still resolves plugin subcommands from validated config.
    expectResolvedPolicy(["nodes"], { networkProxy: "bypass" });
    expectResolvedPolicy(["nodes", "pair"], { networkProxy: "bypass" });
  });

  it("keeps gateway-owned node and device mutations off the local config guard", () => {
    for (const subcommand of [
      "list",
      "join-code",
      "approve",
      "reject",
      "remove",
      "clear",
      "rename",
      "rotate",
      "revoke",
    ]) {
      const commandPath = ["devices", subcommand];
      expectResolvedPolicy(commandPath, {
        configGuard: "validate",
        networkProxy: "bypass",
      });
    }
  });

  it("keeps gateway suspension RPCs on non-observing config validation", () => {
    for (const subcommand of ["suspend", "resume"]) {
      expectResolvedPolicy(["gateway", subcommand], {
        configGuard: "validate",
        networkProxy: "bypass",
      });
    }
  });

  it("applies exact overrides after broader channel plugin rules", () => {
    expectResolvedPolicy(["channels", "send"], {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
    });
    expectResolvedPolicy(["channels", "login"], {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
    });
    expectResolvedPolicy(["channels", "capabilities"], {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
    });
    expectResolvedPolicy(["channels", "add"], {
      loadPlugins: "never",
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    });
    const channelsStatusPolicy = resolveCliCommandPathPolicy(["channels", "status"]);
    expect(channelsStatusPolicy).toEqual({
      ...DEFAULT_EXPECTED_POLICY,
      configGuard: "skip",
      loadPlugins: "never",
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: channelsStatusPolicy.networkProxy,
    });
    expectNetworkProxyResolver(channelsStatusPolicy);
    expect(
      channelsStatusPolicy.networkProxy({
        argv: ["node", "openclaw", "channels", "status"],
        commandPath: ["channels", "status"],
      }),
    ).toBe("bypass");
    expect(
      channelsStatusPolicy.networkProxy({
        argv: ["node", "openclaw", "channels", "status", "--probe"],
        commandPath: ["channels", "status"],
      }),
    ).toBe("default");
    expectResolvedPolicy(["channels", "list"], {
      configGuard: "skip",
      loadPlugins: "never",
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["channels", "logs"], {
      loadPlugins: "never",
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["channels", "remove"], {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["channels", "resolve"], {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    });
  });

  it("keeps config-only agent commands on config-only startup", () => {
    const agentPolicy = resolveCliCommandPathPolicy(["agent"]);
    expect(agentPolicy).toEqual({
      ...DEFAULT_EXPECTED_POLICY,
      configGuard: agentPolicy.configGuard,
      loadPlugins: agentPolicy.loadPlugins,
      pluginRegistry: { scope: "all" },
      networkProxy: agentPolicy.networkProxy,
    });
    expectLoadPluginsResolver(agentPolicy);
    expectConfigGuardResolver(agentPolicy);
    expectNetworkProxyResolver(agentPolicy);
    expect(
      agentPolicy.loadPlugins({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      agentPolicy.loadPlugins({
        argv: ["node", "openclaw", "agent", "--json"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      agentPolicy.loadPlugins({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }),
    ).toBe(true);
    expect(
      agentPolicy.configGuard({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }),
    ).toBe("skip");
    expect(
      agentPolicy.configGuard({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
      }),
    ).toBe("run");
    expect(
      agentPolicy.networkProxy({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }),
    ).toBe("bypass");
    expect(
      agentPolicy.networkProxy({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
      }),
    ).toBe("default");

    expectResolvedPolicy(["agent", "exec"], {
      configGuard: "skip",
      loadPlugins: "never",
      pluginRegistry: { scope: "all" },
      ownsProtocolStdout: true,
      hideBanner: true,
      networkProxy: "default",
    });

    for (const commandPath of [["agents"], ["agents", "list"]]) {
      expectResolvedPolicy(commandPath, {
        configGuard: "skip",
        loadPlugins: "never",
        networkProxy: "bypass",
      });
    }
    for (const commandPath of [
      ["agents", "bind"],
      ["agents", "unbind"],
      ["agents", "set-identity"],
      ["agents", "delete"],
    ]) {
      expectResolvedPolicy(commandPath, {
        loadPlugins: "never",
        networkProxy: "bypass",
      });
    }
    expectResolvedPolicy(["agents", "bindings"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
  });

  it.each([
    ["approvals", "pending"],
    ["skills"],
    ["skills", "list"],
    ["skills", "check"],
    ["gateway", "stability"],
    ["gateway", "usage-cost"],
  ])("keeps read-only cold path %s out of startup config and plugins", (...commandPath) => {
    expectResolvedPolicy(commandPath, {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
  });

  it("resolves mixed startup-only rules", () => {
    expectResolvedPolicy(["qa", "suite"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["worker"], {
      configGuard: "skip",
      loadPlugins: "never",
      hideBanner: true,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["browser", "extension", "native-host"], {
      hideBanner: true,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["configure"], {
      configGuard: "skip",
      loadPlugins: "never",
    });
    expectResolvedPolicy(["config"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config", "file"], {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config", "set"], {
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    const doctorPolicy = resolveCliCommandPathPolicy(["doctor"]);
    expectNetworkProxyResolver(doctorPolicy);
    expect(doctorPolicy).toMatchObject({
      configGuard: "skip",
      loadPlugins: "never",
    });
    expect(
      doctorPolicy.networkProxy({
        argv: ["node", "openclaw", "doctor"],
        commandPath: ["doctor"],
      }),
    ).toBe("default");
    expect(
      doctorPolicy.networkProxy({
        argv: ["node", "openclaw", "doctor", "--state-sqlite=compact"],
        commandPath: ["doctor"],
      }),
    ).toBe("bypass");
    expectResolvedPolicy(["config", "validate"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config", "schema"], {
      configGuard: "skip",
      loadPlugins: "never",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["gateway", "status"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["gateway", "health"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["plugins", "update"], {
      loadPlugins: "never",
      hideBanner: true,
    });
    expectResolvedPolicy(["plugins", "list"], {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    for (const commandPath of [["tasks"], ["tasks", "list"], ["tasks", "audit"]]) {
      expectResolvedPolicy(commandPath, {
        configGuard: "skip",
        ensureCliPath: false,
        loadPlugins: "never",
        networkProxy: "bypass",
      });
    }
    for (const commandPath of [
      ["plugins", "install"],
      ["plugins", "inspect"],
      ["plugins", "registry"],
      ["plugins", "doctor"],
    ]) {
      expectResolvedPolicy(commandPath, {
        loadPlugins: "never",
      });
    }
    expectResolvedPolicy(["cron", "list"], {
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    });
    for (const commandPath of [
      ["hooks"],
      ["hooks", "list"],
      ["hooks", "info"],
      ["hooks", "check"],
      ["skills", "info"],
    ]) {
      expectResolvedPolicy(commandPath, {
        configGuard: "skip",
        loadPlugins: "never",
        networkProxy: "bypass",
      });
    }
    expectResolvedPolicy(["skills", "search"], {
      configGuard: "skip",
      loadPlugins: "never",
    });
    expectResolvedPolicy(["memory", "search"], {
      configGuard: "skip",
      loadPlugins: "always",
      pluginRegistry: { scope: "memory" },
    });
    const memoryStatusPolicy = resolveCliCommandPathPolicy(["memory", "status"]);
    expectConfigGuardResolver(memoryStatusPolicy);
    expect(memoryStatusPolicy.loadPlugins).toBe("always");
    expect(memoryStatusPolicy.pluginRegistry).toEqual({ scope: "memory" });
    expect(
      memoryStatusPolicy.configGuard({
        argv: ["node", "openclaw", "memory", "status"],
        commandPath: ["memory", "status"],
      }),
    ).toBe("skip");
    for (const flag of ["--index", "--fix"]) {
      expect(
        memoryStatusPolicy.configGuard({
          argv: ["node", "openclaw", "memory", "status", flag],
          commandPath: ["memory", "status"],
        }),
      ).toBe("run");
    }
  });

  it("keeps routed and Commander config reads ahead of observing startup guards", () => {
    expectResolvedPolicy(["config", "get"], {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      networkProxy: "bypass",
    });
  });

  it("defaults unknown command paths to network proxy routing", () => {
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "googlemeet", "login"])).toBe(
      "default",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "tool", "image_generate"])).toBe(
      "bypass",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "tools", "effective"])).toBe("bypass");
  });

  it("resolves static network proxy bypass policies from the catalog", () => {
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "status"])).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "config", "get", "proxy.enabled"]),
    ).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "proxy", "start"])).toBe("bypass");
  });

  it("resolves mixed network proxy policies from argv-sensitive catalog entries", () => {
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway", "run"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway", "health"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "node", "run"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "node", "status"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "agent", "--local"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "agent", "run"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "channels", "status"])).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "channels", "status", "--probe"]),
    ).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "status"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "status", "--probe"])).toBe(
      "default",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "--json"])).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy([
        "node",
        "openclaw",
        "models",
        "--agent",
        "main",
        "--status-json",
      ]),
    ).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "--agent", "main", "auth"]),
    ).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "info", "browser"])).toBe(
      "bypass",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "check"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "list"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "search", "browser"])).toBe(
      "default",
    );
  });

  it("routes ClawHub skill verification through the network proxy", () => {
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "verify", "@demo-owner/weather"]),
    ).toBe("default");
  });

  it("uses the longest catalog command path for deep network proxy overrides", async () => {
    const catalog: readonly CliCommandCatalogEntry[] = [
      { commandPath: ["nodes"], policy: { networkProxy: "bypass" } },
      {
        commandPath: ["nodes", "camera", "snap"],
        exact: true,
        policy: { networkProxy: "default" },
      },
    ];

    vi.doMock("./command-catalog.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./command-catalog.js")>();
      return { ...actual, cliCommandCatalog: catalog };
    });
    const { resolveCliNetworkProxyPolicy: resolveCliNetworkProxyPolicyLocal } =
      await importFreshModule<typeof import("./command-path-policy.js")>(
        import.meta.url,
        "./command-path-policy.js?catalog-overrides",
      );

    expect(resolveCliNetworkProxyPolicyLocal(["node", "openclaw", "nodes", "camera", "snap"])).toBe(
      "default",
    );
    expect(resolveCliNetworkProxyPolicyLocal(["node", "openclaw", "nodes", "camera", "list"])).toBe(
      "bypass",
    );
  });

  it("stops catalog policy resolution before positional arguments", () => {
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "config", "get", "proxy.enabled"]),
    ).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "message", "send", "--to", "demo"]),
    ).toBe("default");
  });

  it("treats bare gateway invocations with options as the gateway runtime", () => {
    const argv = ["node", "openclaw", "gateway", "--port", "1234"];

    expect(resolveCliNetworkProxyPolicy(argv)).toBe("default");
  });

  it("resolves gateway runs after root options with values", () => {
    const argv = ["node", "openclaw", "--log-level", "debug", "gateway", "run"];

    expect(resolveCliNetworkProxyPolicy(argv)).toBe("default");
  });

  it("does not let gateway run option values spoof bypass subcommands", () => {
    for (const argv of [
      ["node", "openclaw", "gateway", "--token", "status"],
      ["node", "openclaw", "gateway", "--token=status"],
      ["node", "openclaw", "gateway", "--password", "health"],
      ["node", "openclaw", "gateway", "--password-file", "status"],
      ["node", "openclaw", "gateway", "--ws-log", "compact"],
    ]) {
      expect(resolveCliNetworkProxyPolicy(argv), argv.join(" ")).toBe("default");
    }
  });

  it("still resolves real gateway bypass subcommands after their command token", () => {
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway", "status"])).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway", "status", "--token", "secret"]),
    ).toBe("bypass");
  });
});
