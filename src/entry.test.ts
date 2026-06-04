// Tests CLI entrypoint argument handling and startup behavior.
import { describe, expect, it } from "vitest";
import { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath } from "./entry.js";

describe("entry root help fast path", () => {
  it("prefers precomputed root help text when available", async () => {
    let outputPrecomputedRootHelpTextCalls = 0;

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      env: {},
      outputPrecomputedRootHelpText: () => {
        outputPrecomputedRootHelpTextCalls += 1;
        return true;
      },
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
    });

    expect(handled).toBe(true);
    expect(outputPrecomputedRootHelpTextCalls).toBe(1);
  });

  it("renders root help without importing the full program", async () => {
    let outputRootHelpCalls = 0;

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      outputRootHelp: () => {
        outputRootHelpCalls += 1;
      },
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(true);
    expect(outputRootHelpCalls).toBe(1);
  });

  it("renders live root help when plugin config changes command descriptors", async () => {
    let outputPrecomputedRootHelpTextCalls = 0;
    const outputRootHelpOptions: unknown[] = [];
    const liveOptions = {
      config: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
      env: {},
    };

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      env: {},
      outputPrecomputedRootHelpText: () => {
        outputPrecomputedRootHelpTextCalls += 1;
        return true;
      },
      outputRootHelp: (options) => {
        outputRootHelpOptions.push(options);
      },
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => liveOptions,
    });

    expect(handled).toBe(true);
    expect(outputPrecomputedRootHelpTextCalls).toBe(0);
    expect(outputRootHelpOptions).toEqual([liveOptions]);
  });

  it("ignores non-root help invocations", async () => {
    let outputRootHelpCalls = 0;

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "status", "--help"], {
      outputRootHelp: () => {
        outputRootHelpCalls += 1;
      },
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(false);
    expect(outputRootHelpCalls).toBe(0);
  });

  it("skips the host help fast path when a container target is active", async () => {
    let outputRootHelpCalls = 0;

    const handled = await tryHandleRootHelpFastPath(
      ["node", "openclaw", "--container", "demo", "--help"],
      {
        outputRootHelp: () => {
          outputRootHelpCalls += 1;
        },
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
        env: {},
      },
    );

    expect(handled).toBe(false);
    expect(outputRootHelpCalls).toBe(0);
  });
});

describe("entry precomputed command help fast path", () => {
  it("renders browser help from startup metadata without importing the full program", async () => {
    let outputPrecomputedBrowserHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "browser", "--help"],
      {
        env: {},
        outputPrecomputedBrowserHelpText: () => {
          outputPrecomputedBrowserHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(true);
    expect(outputPrecomputedBrowserHelpTextCalls).toBe(1);
  });

  it("renders secrets help from startup metadata without importing the full program", async () => {
    let outputPrecomputedSecretsHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: () => {
          outputPrecomputedSecretsHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(true);
    expect(outputPrecomputedSecretsHelpTextCalls).toBe(1);
  });

  it("renders nodes help from startup metadata without importing the full program", async () => {
    let outputPrecomputedNodesHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "--help"],
      {
        env: {},
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
        outputPrecomputedNodesHelpText: () => {
          outputPrecomputedNodesHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(true);
    expect(outputPrecomputedNodesHelpTextCalls).toBe(1);
  });

  it("defers nodes help when plugin config can change command metadata", async () => {
    let outputPrecomputedNodesHelpTextCalls = 0;
    let liveConfigChecks = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "--help"],
      {
        env: {},
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => {
          liveConfigChecks += 1;
          return { env: {} };
        },
        outputPrecomputedNodesHelpText: () => {
          outputPrecomputedNodesHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(false);
    expect(liveConfigChecks).toBe(1);
    expect(outputPrecomputedNodesHelpTextCalls).toBe(0);
  });

  it("falls through when startup metadata is unavailable", async () => {
    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: () => false,
      },
    );

    expect(handled).toBe(false);
  });

  it("ignores nested subcommand help invocations", async () => {
    let outputPrecomputedNodesHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "invoke", "--help"],
      {
        env: {},
        outputPrecomputedNodesHelpText: () => {
          outputPrecomputedNodesHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedNodesHelpTextCalls).toBe(0);
  });

  it("ignores command version invocations", async () => {
    let outputPrecomputedNodesHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "--version"],
      {
        env: {},
        outputPrecomputedNodesHelpText: () => {
          outputPrecomputedNodesHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedNodesHelpTextCalls).toBe(0);
  });

  it("respects the startup help fast path kill switch", async () => {
    let outputPrecomputedSecretsHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "secrets", "--help"],
      {
        env: { OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" },
        outputPrecomputedSecretsHelpText: () => {
          outputPrecomputedSecretsHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedSecretsHelpTextCalls).toBe(0);
  });

  it("respects the process env startup help fast path kill switch", async () => {
    let outputPrecomputedSecretsHelpTextCalls = 0;
    const original = process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH;
    process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH = "1";
    try {
      const handled = await tryHandlePrecomputedCommandHelpFastPath(
        ["node", "openclaw", "secrets", "--help"],
        {
          outputPrecomputedSecretsHelpText: () => {
            outputPrecomputedSecretsHelpTextCalls += 1;
            return true;
          },
        },
      );

      expect(handled).toBe(false);
      expect(outputPrecomputedSecretsHelpTextCalls).toBe(0);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH;
      } else {
        process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH = original;
      }
    }
  });

  it("skips the host command help fast path when a container target is active", async () => {
    let outputPrecomputedSecretsHelpTextCalls = 0;

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "--container", "demo", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: () => {
          outputPrecomputedSecretsHelpTextCalls += 1;
          return true;
        },
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedSecretsHelpTextCalls).toBe(0);
  });
});
