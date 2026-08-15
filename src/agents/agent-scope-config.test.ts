// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import { describe, expect, it, vi } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentSelectionRequiredError,
  listAgentEntriesWithSource,
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSoleAgentId,
  resolveSystemAgentTargetAgentId,
  tryResolveDefaultAgentId,
  tryResolveSoleAgentId,
  tryResolveSystemAgentTargetAgentId,
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

  it("preserves raw legacy markers while sole-agent lookup stays strict", () => {
    expect(resolveSoleAgentId({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    expect(tryResolveSoleAgentId({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    const missingDefault = { agents: { list: [{ id: "alpha" }, { id: "beta" }] } };
    expect(() => resolveDefaultAgentId(missingDefault)).toThrow(AgentSelectionRequiredError);
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
    expect(() => resolveDefaultAgentId(duplicateDefaults)).toThrow(AgentSelectionRequiredError);
    expect(tryResolveDefaultAgentId(duplicateDefaults)).toBeUndefined();
  });

  it("keeps the generic selection hint free of surface-specific assumptions", () => {
    expect(() => resolveDefaultAgentId({ agents: { entries: { alpha: {}, beta: {} } } })).toThrow(
      "Multiple agents are configured, but this operation has no explicit owner. Select an agent explicitly; CLI callers can pass --agent <id>, channels can add a binding, and ambient services can set their agentId target.",
    );
  });

  it("requires an explicit system owner when a roster has multiple agents", () => {
    expect(
      resolveSystemAgentTargetAgentId({
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: { default: true }, ops: {} },
        },
      }),
    ).toBe("ops");
    expect(resolveSystemAgentTargetAgentId({ agents: { entries: { ops: {} } } })).toBe("ops");
    expect(
      tryResolveSystemAgentTargetAgentId({
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: {}, ops: {} },
        },
      }),
    ).toBe("ops");
    expect(tryResolveSystemAgentTargetAgentId({ agents: { entries: { ops: {} } } })).toBe("ops");
    expect(
      tryResolveSystemAgentTargetAgentId({ agents: { entries: { main: {}, ops: {} } } }),
    ).toBeUndefined();
    expect(() =>
      resolveSystemAgentTargetAgentId({
        agents: { entries: { main: { default: true }, ops: {} } },
      }),
    ).toThrow("Set agents.defaults.systemAgent.agentId");
  });

  it("resolves defaults only for the rosterless implicit main agent", () => {
    const defaults = { fastModeDefault: "auto" as const };

    expect(resolveAgentConfig({ agents: { defaults } }, "main")?.fastModeDefault).toBe("auto");
    expect(resolveAgentConfig({ agents: { defaults } }, "work")).toBeUndefined();
    expect(resolveAgentConfig({ agents: { defaults, entries: {} } }, "main")).toBeUndefined();
    expect(resolveAgentConfig({ agents: { defaults, list: [] } }, "main")).toBeUndefined();
  });

  it("keeps the retained legacy owner on the inherited workspace before config write", () => {
    const cfg = migratePersistedImplicitMainRoster({
      agents: {
        defaults: { workspace: "/srv/ops" },
        entries: { ops: { default: true }, research: {} },
      },
    }).config as OpenClawConfig;

    expect(cfg.agents?.entries?.ops?.default).toBeUndefined();
    expect(cfg.agents?.entries?.ops?.workspace).toBeUndefined();
    expect(resolveAgentWorkspaceDir(cfg, "ops")).toBe("/srv/ops");
    expect(resolveAgentWorkspaceDir(cfg, "research")).toBe("/srv/ops/research");
  });

  it("keeps a raw legacy marker owner on the inherited workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/srv/ops" },
        entries: { ops: { default: true }, research: {} },
      },
    };

    expect(resolveAgentWorkspaceDir(cfg, "ops")).toBe("/srv/ops");
    expect(resolveAgentWorkspaceDir(cfg, "research")).toBe("/srv/ops/research");
  });

  it("keeps the implicit default workspace inside an overridden state directory", () => {
    const stateDir = "/srv/openclaw-scratch";

    expect(
      resolveAgentWorkspaceDir({}, "main", {
        HOME: "/home/operator",
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBe(`${stateDir}/workspace`);
  });

  it("offers a non-throwing diagnostic lookup for malformed rosters", () => {
    expect(tryResolveDefaultAgentId({ agents: { list: [{ id: "alpha" }] } })).toBe("alpha");
    for (const marker of ["false", 1]) {
      expect(
        tryResolveDefaultAgentId({
          agents: { entries: { alpha: { default: marker } } },
        } as unknown as OpenClawConfig),
      ).toBe("alpha");
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
