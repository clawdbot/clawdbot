import { describe, expect, it } from "vitest";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
  shouldBuildCoreCodingToolsForAllowlist,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";

type EmbeddedAttemptToolConstructionPlan = ReturnType<
  typeof resolveEmbeddedAttemptToolConstructionPlan
>;

function expectConstructionPlan(
  plan: EmbeddedAttemptToolConstructionPlan,
  expected: {
    constructTools?: boolean;
    includeCoreTools?: boolean;
    runtimeToolAllowlist?: string[];
    coding?: Partial<EmbeddedAttemptToolConstructionPlan["codingToolConstructionPlan"]>;
  },
) {
  if ("constructTools" in expected) {
    expect(plan.constructTools).toBe(expected.constructTools);
  }
  if ("includeCoreTools" in expected) {
    expect(plan.includeCoreTools).toBe(expected.includeCoreTools);
  }
  if ("runtimeToolAllowlist" in expected) {
    expect(plan.runtimeToolAllowlist).toEqual(expected.runtimeToolAllowlist);
  }
  if (expected.coding) {
    for (const [key, value] of Object.entries(expected.coding)) {
      expect(plan.codingToolConstructionPlan[key as keyof typeof expected.coding]).toBe(value);
    }
  }
}

describe("applyEmbeddedAttemptToolsAllow", () => {
  it("keeps explicit toolsAllow authoritative after force-added tools are built", () => {
    const tools = [{ name: "exec" }, { name: "read" }, { name: "message" }];

    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["exec", "read"]).map((tool) => tool.name),
    ).toEqual(["exec", "read"]);
  });

  it("normalizes explicit toolsAllow entries before filtering", () => {
    const tools = [{ name: "cron" }, { name: "read" }, { name: "message" }];

    expect(
      applyEmbeddedAttemptToolsAllow(tools, [" cron ", "READ"]).map((tool) => tool.name),
    ).toEqual(["cron", "read"]);
  });

  it("honors wildcard and group allowlists in the final filter", () => {
    const tools = [{ name: "exec" }, { name: "read" }, { name: "message" }];

    expect(applyEmbeddedAttemptToolsAllow(tools, ["*"]).map((tool) => tool.name)).toEqual([
      "exec",
      "read",
      "message",
    ]);
    expect(applyEmbeddedAttemptToolsAllow(tools, ["group:fs"]).map((tool) => tool.name)).toEqual([
      "read",
    ]);
  });

  it("keeps plugin-only allowlists on the shared tool policy path", () => {
    const tools = [{ name: "memory_search" }, { name: "plugin_extra" }];

    expect(shouldBuildCoreCodingToolsForAllowlist(["memory_search"])).toBe(false);
    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["memory_search"]).map((tool) => tool.name),
    ).toEqual(["memory_search"]);
  });

  it("expands plugin group and plugin-id allowlists before the final filter", () => {
    const tools = [
      { name: "exec" },
      { name: "memory_search" },
      { name: "memory_get" },
      { name: "browser" },
    ];
    const toolMeta = (tool: { name: string }) => {
      if (tool.name.startsWith("memory_")) {
        return { pluginId: "active-memory" };
      }
      if (tool.name === "browser") {
        return { pluginId: "browser" };
      }
      return undefined;
    };

    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["group:plugins"], { toolMeta }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["memory_search", "memory_get", "browser"]);
    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["active-memory"], { toolMeta }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["memory_search", "memory_get"]);
  });

  it("treats an explicit empty toolsAllow as no tools", () => {
    const tools = [{ name: "exec" }, { name: "read" }, { name: "message" }];

    expect(applyEmbeddedAttemptToolsAllow(tools, []).map((tool) => tool.name)).toStrictEqual([]);
    expect(shouldBuildCoreCodingToolsForAllowlist([])).toBe(false);
  });
});

describe("resolveEmbeddedAttemptToolConstructionPlan", () => {
  it("builds all tool families when no runtime allowlist is present", () => {
    expectConstructionPlan(resolveEmbeddedAttemptToolConstructionPlan({}), {
      constructTools: true,
      includeCoreTools: true,
      coding: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: true,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });
  });

  it("short-circuits all local tool construction for explicit no-tools runs", () => {
    expectConstructionPlan(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: [] }), {
      constructTools: false,
      includeCoreTools: false,
      coding: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
  });

  it("materializes only plugin candidates for plugin-only allowlists", () => {
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["memory_search"] }),
      {
        constructTools: true,
        includeCoreTools: false,
        runtimeToolAllowlist: ["memory_search"],
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: true,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      },
    );
  });

  it("limits known core allowlists to the matching local families", () => {
    expectConstructionPlan(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["read"] }), {
      constructTools: true,
      includeCoreTools: true,
      coding: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    expectConstructionPlan(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["exec"] }), {
      coding: {
        includeBaseCodingTools: false,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["session_status"] }),
      {
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      },
    );
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["update_plan"] }),
      {
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      },
    );
  });

  it("keeps plugin-owned catalog tools on the plugin construction path", () => {
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["browser"] }),
      {
        constructTools: true,
        includeCoreTools: false,
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: true,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      },
    );
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["code_execution"] }),
      {
        constructTools: true,
        includeCoreTools: false,
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: true,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      },
    );
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["x_search"] }),
      {
        includeCoreTools: false,
        coding: {
          includeChannelTools: true,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      },
    );
  });

  it("keeps channel tools available for narrow channel-owned allowlists", () => {
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["whatsapp_login"] }),
      {
        constructTools: true,
        includeCoreTools: false,
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: true,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      },
    );
  });

  it("skips local construction when only bundled tool runtimes can match", () => {
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["strict__strict_probe"] }),
      {
        constructTools: false,
        includeCoreTools: false,
      },
    );
  });
});

describe("shouldCreateBundleMcpRuntimeForAttempt", () => {
  it("skips bundle MCP runtime when tools are disabled", () => {
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: false })).toBe(false);
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, disableTools: true })).toBe(
      false,
    );
  });

  it("creates bundle MCP only when the allowlist can reach bundle MCP tool names", () => {
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true })).toBe(true);
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, toolsAllow: ["*"] })).toBe(
      true,
    );
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, toolsAllow: [] })).toBe(
      false,
    );
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["memory_search", "memory_get"],
      }),
    ).toBe(false);
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["group:plugins"],
      }),
    ).toBe(true);
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["bundle-mcp"],
      }),
    ).toBe(true);
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["strict__strict_probe"],
      }),
    ).toBe(true);
  });
});

describe("shouldCreateBundleLspRuntimeForAttempt", () => {
  it("skips bundle LSP startup when runtime allowlists cannot reach LSP tools", () => {
    expect(shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true })).toBe(true);
    expect(shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true, toolsAllow: ["*"] })).toBe(
      true,
    );
    expect(shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true, toolsAllow: [] })).toBe(
      false,
    );
    expect(
      shouldCreateBundleLspRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["memory_search"],
      }),
    ).toBe(false);
    expect(
      shouldCreateBundleLspRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["lsp_hover_typescript"],
      }),
    ).toBe(true);
  });
});
