// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAgentEntriesWithSource,
  listAgentIds,
  resolveAgentConfig,
  resolveDefaultAgentId,
  tryResolveDefaultAgentId,
} from "./agent-scope-config.js";

vi.unmock("./agent-scope-config.js");

describe("agent roster resolution", () => {
  it("preserves the Plugin SDK fallback only when the roster property is absent", () => {
    expect(listAgentIds({})).toEqual(["main"]);
    expect(listAgentIds({ agents: { entries: {} } })).toEqual([]);
    expect(resolveDefaultAgentId({})).toBe("main");
    expect(resolveDefaultAgentId({ agents: { list: undefined } })).toBe("main");
    expect(resolveDefaultAgentId({ agents: { defaults: { workspace: "/srv/main" } } })).toBe(
      "main",
    );
    expect(() => resolveDefaultAgentId({ agents: { entries: {} } })).toThrow(
      "No agents configured",
    );
    expect(() => resolveDefaultAgentId({ agents: { list: [] } })).toThrow("No agents configured");
  });

  it("preserves legacy first-entry selection while diagnostic lookup stays strict", () => {
    const missingDefault = { agents: { list: [{ id: "alpha" }, { id: "beta" }] } };
    expect(resolveDefaultAgentId(missingDefault)).toBe("alpha");
    expect(tryResolveDefaultAgentId(missingDefault)).toBeUndefined();
    expect(
      resolveDefaultAgentId({
        agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
      }),
    ).toBe("beta");
    const duplicateDefaults = {
      agents: {
        list: [
          { id: "alpha", default: true },
          { id: "beta", default: true },
        ],
      },
    };
    expect(resolveDefaultAgentId(duplicateDefaults)).toBe("alpha");
    expect(tryResolveDefaultAgentId(duplicateDefaults)).toBeUndefined();
  });

  it("offers a non-throwing diagnostic lookup for malformed rosters", () => {
    expect(tryResolveDefaultAgentId({ agents: { list: [{ id: "alpha" }] } })).toBeUndefined();
    for (const marker of ["false", 1]) {
      expect(
        tryResolveDefaultAgentId({
          agents: { entries: { alpha: { default: marker } } },
        } as unknown as OpenClawConfig),
      ).toBeUndefined();
    }
  });

  it("copies own __proto__ fields without changing the listed entry prototype", () => {
    const entry = JSON.parse('{"__proto__":{"tools":{"allow":["*"]}}}') as Record<string, unknown>;
    const [listed] = listAgentEntriesWithSource({
      agents: { entries: { ops: entry } },
    } as OpenClawConfig);
    expect(listed).toBeDefined();
    const listedEntry = listed!.entry;

    expect(Object.getPrototypeOf(listedEntry)).toBe(Object.prototype);
    expect(Object.hasOwn(listedEntry, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(listedEntry, "__proto__")?.value).toEqual({
      tools: { allow: ["*"] },
    });
    expect(listedEntry.tools).toBeUndefined();
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
