// Split out of agent-exec.test.ts (over the oxlint max-lines cap): covers the
// producer-side implicit roster that `buildExecRunOverlay` materializes for
// rosterless exec runs (`--isolated`/`--auth-env-only`), and pins that the
// materialized config is actually admitted by the shared workspace resolver.
import { describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { buildExecRunConfig } from "./agent-exec.js";

describe("agent exec run config layering: implicit roster for rosterless runs", () => {
  it("materializes the implicit one-agent roster for a rosterless base (--isolated/--auth-env-only)", () => {
    // `resolveExecBaseConfig` returns `{}` for `--isolated`/`--auth-env-only`
    // by design. The shared workspace resolver refuses rosterless input (it
    // is also reachable from raw embedded/SDK callers), so this producer
    // must materialize its own implicit one-agent roster rather than lean on
    // that resolver to invent one.
    const config = buildExecRunConfig({ base: {}, cwd: "/run/here" });

    expect(config.agents?.entries).toEqual({
      main: { default: true, workspace: "/run/here" },
    });

    // Pins the producer-to-resolver path end to end: the materialized config
    // must actually be admitted by resolveRunWorkspaceDir, including the
    // explicit default-agent flow from #119765 (`agent exec` resolving
    // `resolveDefaultAgentId` itself and passing it through as `agentId`).
    const unspecified = resolveRunWorkspaceDir({ workspaceDir: undefined, config });
    expect(unspecified.agentId).toBe("main");
    expect(unspecified.agentIdSource).toBe("default");

    const explicit = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      agentId: "main",
      config,
    });
    expect(explicit.agentId).toBe("main");
    expect(explicit.agentIdSource).toBe("explicit");
  });

  it("does not override an already-configured roster with the implicit default", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: { default: true } } } },
      cwd: "/run/here",
    });

    expect(config.agents?.entries).toEqual({ ops: { default: true, workspace: "/run/here" } });
    expect(config.agents?.entries?.main).toBeUndefined();
  });
});
