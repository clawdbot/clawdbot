// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentIds, resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";

describe("agent roster resolution", () => {
  it("does not synthesize ids for an empty roster", () => {
    expect(listAgentIds({})).toEqual([]);
    expect(() => resolveDefaultAgentId({})).toThrow("No agents configured");
  });

  it("requires one explicit default", () => {
    expect(() =>
      resolveDefaultAgentId({ agents: { list: [{ id: "alpha" }, { id: "beta" }] } }),
    ).toThrow("exactly one default=true");
    expect(
      resolveDefaultAgentId({
        agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
      }),
    ).toBe("beta");
  });
});

describe("resolveAgentConfig model policy", () => {
  it("keeps an empty per-agent policy inherited instead of flattening it", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "main", modelPolicy: {} }],
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.modelPolicy).toBeUndefined();
  });

  it("returns an explicit per-agent allowlist override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "main", modelPolicy: { allow: ["openai/gpt-5.6-sol"] } }],
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.modelPolicy).toEqual({
      allow: ["openai/gpt-5.6-sol"],
    });
  });
});
