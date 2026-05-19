import { describe, expect, it } from "vitest";
import { tryHandleRootHelpFastPath } from "./entry.js";

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
