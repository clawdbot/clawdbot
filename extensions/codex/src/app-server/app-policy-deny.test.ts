import { describe, expect, it } from "vitest";
import {
  createCodexAppDenyGate,
  findUnmatchedCodexAppDenyPatterns,
  normalizeCodexDeniedAppPatterns,
  readCodexAppModelToolNamesForDenies,
  resolveCodexAppDenyDecision,
} from "./app-policy-deny.js";

describe("normalizeCodexDeniedAppPatterns", () => {
  it("keeps only well-formed namespace patterns, lowercased, unique, sorted", () => {
    expect(
      normalizeCodexDeniedAppPatterns([
        " MCP__codex_apps__Gamma_* ",
        "mcp__codex_apps__gamma_*",
        "mcp__codex_apps__epsilon_*",
        "mcp__codex_apps__*",
        "mcp__codex_apps__x_*_y_*",
        "mcp__codex_apps__exact_tool",
        "alpha__*",
      ]),
    ).toEqual(["mcp__codex_apps__*", "mcp__codex_apps__epsilon_*", "mcp__codex_apps__gamma_*"]);
    expect(normalizeCodexDeniedAppPatterns(undefined)).toEqual([]);
  });
});

describe("resolveCodexAppDenyDecision", () => {
  const patterns = ["mcp__codex_apps__gamma_*"];
  const gammaTools = ["mcp__codex_apps__gamma_list_items", "mcp__codex_apps__gamma_send_item"];

  it("allows apps no pattern covers", () => {
    expect(resolveCodexAppDenyDecision({ modelToolNames: ["delta.list_things"], patterns })).toBe(
      "allowed",
    );
    expect(resolveCodexAppDenyDecision({ modelToolNames: undefined, patterns: [] })).toBe(
      "allowed",
    );
  });

  it("denies apps whose every tool a pattern covers", () => {
    expect(resolveCodexAppDenyDecision({ modelToolNames: gammaTools, patterns })).toBe("denied");
    expect(
      resolveCodexAppDenyDecision({
        modelToolNames: gammaTools,
        patterns: ["mcp__codex_apps__gam*"],
      }),
    ).toBe("denied");
    expect(
      resolveCodexAppDenyDecision({ modelToolNames: gammaTools, patterns: ["mcp__codex_apps__*"] }),
    ).toBe("denied");
  });

  it("fails closed for partial coverage or unreadable tools", () => {
    expect(
      resolveCodexAppDenyDecision({
        modelToolNames: gammaTools,
        patterns: ["mcp__codex_apps__gamma_send_*"],
      }),
    ).toBe("unenforceable");
    expect(resolveCodexAppDenyDecision({ modelToolNames: undefined, patterns })).toBe(
      "unenforceable",
    );
    expect(resolveCodexAppDenyDecision({ modelToolNames: [], patterns })).toBe("unenforceable");
  });
});

describe("readCodexAppModelToolNamesForDenies", () => {
  it("returns model-visible names grouped by connector id", async () => {
    const names = await readCodexAppModelToolNamesForDenies({
      patterns: ["mcp__codex_apps__gamma_*"],
      request: async (method) => {
        expect(method).toBe("mcpServerStatus/list");
        return {
          data: [
            { name: "other", tools: { "other.tool": {} } },
            {
              name: "codex_apps",
              tools: {
                "delta.list_things": {
                  _meta: { connector_id: "asdk_app_delta", connector_display_name: "Delta" },
                },
                "gamma.list_items": {
                  _meta: { connector_id: "asdk_app_gamma", connector_name: "Gamma" },
                },
                "gamma.send_item": {
                  _meta: { connector_id: "asdk_app_gamma", connector_name: "Gamma" },
                },
                orphan: {},
              },
            },
          ],
          nextCursor: null,
        };
      },
    });
    expect([...(names ?? [])]).toEqual([
      ["asdk_app_delta", ["mcp__codex_apps__delta_list_things"]],
      ["asdk_app_gamma", ["mcp__codex_apps__gamma_list_items", "mcp__codex_apps__gamma_send_item"]],
    ]);
  });

  it("skips the read without patterns and fails closed when the read throws", async () => {
    expect(
      await readCodexAppModelToolNamesForDenies({
        patterns: [],
        request: async () => {
          throw new Error("must not be called");
        },
      }),
    ).toEqual(new Map());
    expect(
      await readCodexAppModelToolNamesForDenies({
        patterns: ["mcp__codex_apps__gamma_*"],
        request: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeUndefined();
  });
});

describe("findUnmatchedCodexAppDenyPatterns", () => {
  const modelToolNamesByApp = new Map<string, readonly string[]>([
    ["asdk_app_delta", ["mcp__codex_apps__delta_list_things"]],
    ["asdk_app_gamma", ["mcp__codex_apps__gamma_list_items", "mcp__codex_apps__gamma_send_item"]],
  ]);

  it("returns only patterns that touch no known app tool", () => {
    expect(
      findUnmatchedCodexAppDenyPatterns({
        modelToolNamesByApp,
        patterns: [
          "mcp__codex_apps__gamma_*",
          "mcp__codex_apps__gamma_send_*",
          "mcp__codex_apps__*",
          "mcp__codex_apps__zeta_*",
          "mcp__codex_apps__gamma__*",
        ],
      }),
    ).toEqual(["mcp__codex_apps__zeta_*", "mcp__codex_apps__gamma__*"]);
    expect(findUnmatchedCodexAppDenyPatterns({ modelToolNamesByApp, patterns: [] })).toEqual([]);
  });
});

describe("createCodexAppDenyGate", () => {
  it("admits, skips, or fails closed per app and records deny diagnostics", () => {
    const diagnostics: unknown[] = [];
    const gate = createCodexAppDenyGate<string>({
      modelToolNamesByApp: new Map([
        ["asdk_app_delta", ["mcp__codex_apps__delta_list_things"]],
        [
          "asdk_app_gamma",
          ["mcp__codex_apps__gamma_list_items", "mcp__codex_apps__gamma_send_item"],
        ],
      ]),
      patterns: ["mcp__codex_apps__gamma_*"],
      onDenied: (diagnostic) => diagnostics.push(diagnostic),
      failClosed: (appId) => `closed:${appId}`,
    });
    expect(gate.unmatched).toEqual([]);
    expect(gate.apply("asdk_app_delta")).toBe(false);
    expect(gate.apply("asdk_app_gamma")).toBe(true);
    expect(gate.apply("asdk_app_unknown")).toBe("closed:asdk_app_unknown");
    expect(diagnostics).toEqual([
      { code: "app_denied_by_policy", message: "asdk_app_gamma is denied by tool policy." },
    ]);
  });
});
