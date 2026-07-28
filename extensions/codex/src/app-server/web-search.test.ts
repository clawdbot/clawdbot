import { describe, expect, it } from "vitest";
import { resolveCodexWebSearchPlan } from "./web-search.js";

describe("resolveCodexWebSearchPlan", () => {
  it("uses Codex hosted web search by default when no managed provider is selected", () => {
    expect(resolveCodexWebSearchPlan({})).toEqual({
      kind: "native-hosted",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "cached",
      },
    });
  });

  it("projects Codex native web search tuning into thread config", () => {
    const plan = resolveCodexWebSearchPlan({
      config: {
        tools: {
          web: {
            search: {
              openaiCodex: {
                enabled: true,
                mode: "live",
                allowedDomains: [" example.com ", "example.com", ""],
                contextSize: "high",
                userLocation: {
                  country: " CA ",
                  region: " Alberta ",
                  city: " Edmonton ",
                  timezone: "America/Edmonton",
                },
              },
            },
          },
        },
      },
    });

    expect(plan).toEqual({
      kind: "native-hosted",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "live",
        "tools.web_search.allowed_domains": ["example.com"],
        "tools.web_search.context_size": "high",
        "tools.web_search.location.country": "CA",
        "tools.web_search.location.region": "Alberta",
        "tools.web_search.location.city": "Edmonton",
        "tools.web_search.location.timezone": "America/Edmonton",
      },
    });
  });

  it("keeps managed web_search when an explicit managed provider is selected", () => {
    expect(
      resolveCodexWebSearchPlan({
        config: {
          tools: {
            web: {
              search: { provider: "brave" },
            },
          },
        },
      }),
    ).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("keeps managed web_search for an explicit Codex native search opt-out", () => {
    expect(
      resolveCodexWebSearchPlan({
        config: {
          tools: {
            web: {
              search: { openaiCodex: { enabled: false } },
            },
          },
        },
      }),
    ).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("keeps managed web_search when runtime policy disables Codex native tools", () => {
    expect(resolveCodexWebSearchPlan({ nativeToolSurfaceEnabled: false })).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("keeps managed web_search when the active Codex provider lacks hosted search", () => {
    expect(resolveCodexWebSearchPlan({ nativeProviderWebSearchSupport: "unsupported" })).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("keeps managed web_search when active provider support is unknown", () => {
    expect(resolveCodexWebSearchPlan({ nativeProviderWebSearchSupport: "unknown" })).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("fails closed instead of bypassing native domain restrictions through managed fallback", () => {
    expect(
      resolveCodexWebSearchPlan({
        config: {
          tools: {
            web: {
              search: { openaiCodex: { allowedDomains: ["example.com"] } },
            },
          },
        },
        nativeProviderWebSearchSupport: "unsupported",
      }),
    ).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("disables native and managed search for tool-disabled runs", () => {
    expect(resolveCodexWebSearchPlan({ disableTools: true })).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("disables native and managed search when effective tool policy denies web_search", () => {
    expect(resolveCodexWebSearchPlan({ webSearchAllowed: false })).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("disables both native and managed search when OpenClaw web search is disabled", () => {
    expect(
      resolveCodexWebSearchPlan({
        config: {
          tools: {
            web: {
              search: { enabled: false },
            },
          },
        },
      }),
    ).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });
});
