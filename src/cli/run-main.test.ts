import { describe, expect, it } from "vitest";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import {
  rewriteUpdateFlagArgv,
  resolveMissingPluginCommandMessage,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { isGatewayRunFastPathArgv } from "./run-main.js";

const memoryWikiCommandAliasRegistry: PluginManifestCommandAliasRegistry = {
  plugins: [
    {
      id: "memory-wiki",
      commandAliases: [{ name: "wiki" }],
    },
  ],
};

const memoryCoreCommandAliasRegistry: PluginManifestCommandAliasRegistry = {
  plugins: [
    {
      id: "memory-core",
      commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
    },
  ],
};

describe("isGatewayRunFastPathArgv", () => {
  it("matches only plain gateway foreground starts without root options or help", () => {
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway"])).toBe(true);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "--force"])).toBe(true);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "--port", "18789"])).toBe(true);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "--auth=none"])).toBe(true);
    expect(
      isGatewayRunFastPathArgv(["node", "openclaw", "--no-color", "gateway", "--bind", "loopback"]),
    ).toBe(true);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "run"])).toBe(true);
    expect(
      isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "run", "--raw-stream-path", "x"]),
    ).toBe(true);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "call", "health"])).toBe(false);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "--help"])).toBe(false);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "--port"])).toBe(false);
    expect(isGatewayRunFastPathArgv(["node", "openclaw", "gateway", "--unknown"])).toBe(false);
  });
});

describe("rewriteUpdateFlagArgv", () => {
  it("leaves argv unchanged when --update is absent", () => {
    const argv = ["node", "entry.js", "status"];
    expect(rewriteUpdateFlagArgv(argv)).toBe(argv);
  });

  it("rewrites --update into the update command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update"])).toEqual([
      "node",
      "entry.js",
      "update",
    ]);
  });

  it("preserves global flags that appear before --update", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--profile", "p", "--update"])).toEqual([
      "node",
      "entry.js",
      "--profile",
      "p",
      "update",
    ]);
  });

  it("keeps update options after the rewritten command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update", "--json"])).toEqual([
      "node",
      "entry.js",
      "update",
      "--json",
    ]);
  });
});

describe("shouldEnsureCliPath", () => {
  it("skips path bootstrap for help/version invocations", () => {
    expect(shouldEnsureCliPath(["node", "openclaw", "--help"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "-V"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "-v"])).toBe(false);
  });

  it("skips path bootstrap for read-only fast paths", () => {
    expect(shouldEnsureCliPath(["node", "openclaw"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "--profile", "work"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "status"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "--log-level", "debug", "status"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "sessions", "--json"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "config", "get", "update"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "models", "status", "--json"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "tools", "effective"])).toBe(false);
  });

  it("keeps path bootstrap for mutating or unknown commands", () => {
    expect(shouldEnsureCliPath(["node", "openclaw", "message", "send"])).toBe(true);
    expect(shouldEnsureCliPath(["node", "openclaw", "voicecall", "status"])).toBe(true);
    expect(shouldEnsureCliPath(["node", "openclaw", "acp", "-v"])).toBe(true);
  });
});

describe("shouldStartCrestodianForBareRoot", () => {
  it("starts Crestodian for bare root invocations", () => {
    expect(shouldStartCrestodianForBareRoot(["node", "openclaw"])).toBe(true);
    expect(shouldStartCrestodianForBareRoot(["node", "openclaw", "--profile", "work"])).toBe(true);
    expect(shouldStartCrestodianForBareRoot(["node", "openclaw", "--dev"])).toBe(true);
  });

  it("does not start Crestodian for help, version, or commands", () => {
    expect(shouldStartCrestodianForBareRoot(["node", "openclaw", "--help"])).toBe(false);
    expect(shouldStartCrestodianForBareRoot(["node", "openclaw", "-V"])).toBe(false);
    expect(shouldStartCrestodianForBareRoot(["node", "openclaw", "status"])).toBe(false);
  });
});

describe("shouldStartCrestodianForModernOnboard", () => {
  it("starts Crestodian before heavy command registration for modern onboard", () => {
    expect(
      shouldStartCrestodianForModernOnboard([
        "node",
        "openclaw",
        "onboard",
        "--modern",
        "--non-interactive",
        "--json",
      ]),
    ).toBe(true);
  });

  it("keeps classic onboard and help on the normal command path", () => {
    expect(shouldStartCrestodianForModernOnboard(["node", "openclaw", "onboard"])).toBe(false);
    expect(
      shouldStartCrestodianForModernOnboard(["node", "openclaw", "onboard", "--modern", "--help"]),
    ).toBe(false);
  });
});

describe("shouldStartProxyForCli", () => {
  it("starts managed proxy routing for the --update shorthand", () => {
    expect(shouldStartProxyForCli(["node", "openclaw", "--update"])).toBe(true);
    expect(shouldStartProxyForCli(["node", "openclaw", "--profile", "p", "--update"])).toBe(true);
  });
});

describe("shouldUseRootHelpFastPath", () => {
  it("uses the fast path for root help only", () => {
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "--help"])).toBe(true);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "--profile", "work", "-h"])).toBe(true);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "help", "--help"])).toBe(true);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "tools", "--help"])).toBe(true);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "status", "--help"])).toBe(false);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "--help", "status"])).toBe(false);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "help", "gateway"])).toBe(false);
  });
});

describe("shouldUseBrowserHelpFastPath", () => {
  it("uses the fast path for browser command help only", () => {
    expect(shouldUseBrowserHelpFastPath(["node", "openclaw", "browser", "--help"])).toBe(true);
    expect(shouldUseBrowserHelpFastPath(["node", "openclaw", "browser", "-h"])).toBe(true);
    expect(
      shouldUseBrowserHelpFastPath(["node", "openclaw", "--profile", "work", "browser", "-h"]),
    ).toBe(true);
    expect(shouldUseBrowserHelpFastPath(["node", "openclaw", "browser", "status", "--help"])).toBe(
      false,
    );
    expect(shouldUseBrowserHelpFastPath(["node", "openclaw", "status", "--help"])).toBe(false);
  });
});

describe("resolveMissingPluginCommandMessage", () => {
  it("explains plugins.allow misses for a bundled plugin command", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          allow: ["quietchat"],
        },
      }),
    ).toContain('`plugins.allow` excludes "browser"');
  });

  it("explains explicit bundled plugin disablement", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      }),
    ).toContain("plugins.entries.browser.enabled=false");
  });

  it("returns null when the bundled plugin command is already allowed", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          allow: ["browser"],
        },
      }),
    ).toBeNull();
  });

  it("does not classify reserved non-plugin command roots as plugin allowlist misses", () => {
    const message = resolveMissingPluginCommandMessage("tool", {
      plugins: {
        allow: ["browser"],
      },
    });
    expect(message).toBeNull();
  });

  it("explains that dreaming is a runtime slash command, not a CLI command", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {},
      {
        registry: memoryCoreCommandAliasRegistry,
      },
    );
    expect(message).toContain("runtime slash command");
    expect(message).toContain("/dreaming");
    expect(message).toContain("memory-core");
    expect(message).toContain("openclaw memory");
  });

  it("returns the runtime command message even when plugins.allow is set", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {
        plugins: {
          allow: ["memory-core"],
        },
      },
      {
        registry: memoryCoreCommandAliasRegistry,
      },
    );
    expect(message).toContain("runtime slash command");
    expect(message).not.toContain("plugins.allow");
  });

  it("points command names in plugins.allow at their parent plugin", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {
        plugins: {
          allow: ["dreaming"],
        },
      },
      {
        registry: memoryCoreCommandAliasRegistry,
      },
    );
    expect(message).toContain('"dreaming" is not a plugin');
    expect(message).toContain('"memory-core"');
    expect(message).toContain("plugins.allow");
  });

  it("explains parent plugin disablement for runtime command aliases", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {
        plugins: {
          entries: {
            "memory-core": {
              enabled: false,
            },
          },
        },
      },
      {
        registry: memoryCoreCommandAliasRegistry,
      },
    );
    expect(message).toContain("plugins.entries.memory-core.enabled=false");
    expect(message).not.toContain("runtime slash command");
  });

  it("allows CLI commands when their parent plugin is in plugins.allow", () => {
    const message = resolveMissingPluginCommandMessage(
      "wiki",
      {
        plugins: {
          allow: ["memory-wiki"],
        },
      },
      { registry: memoryWikiCommandAliasRegistry },
    );
    expect(message).toBeNull();
  });

  it("blocks CLI commands when parent plugin is NOT in plugins.allow", () => {
    const message = resolveMissingPluginCommandMessage(
      "wiki",
      {
        plugins: {
          allow: ["quietchat"],
        },
      },
      { registry: memoryWikiCommandAliasRegistry },
    );
    expect(message).not.toBeNull();
    expect(message).toContain('"memory-wiki"');
    expect(message).toContain("plugins.allow");
  });
});
