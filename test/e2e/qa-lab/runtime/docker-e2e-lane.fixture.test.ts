// Docker E2E lane fixture tests keep QA scenario dispatch policy reusable.
import { describe, expect, it, vi } from "vitest";
import {
  formatQaDockerE2eLaneUsage,
  listQaDockerE2eLaneNames,
  parseQaDockerE2eLaneArgs,
  resolveQaDockerE2eLane,
  runQaDockerE2eLane,
} from "./docker-e2e-lane.fixture.ts";

describe("QA Docker E2E lane fixture", () => {
  it("lists known Docker lanes for scenario wrappers", () => {
    expect(listQaDockerE2eLaneNames()).toEqual(
      expect.arrayContaining([
        "agent-bundle-mcp-tools",
        "system-agent-first-run",
        "gateway-network",
        "release-plugin-marketplace",
        "update-migration",
        "update-restart-auth",
      ]),
    );
    expect(listQaDockerE2eLaneNames()).toEqual([...listQaDockerE2eLaneNames()].sort());
  });

  it("parses help, list, and lane arguments", () => {
    expect(parseQaDockerE2eLaneArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseQaDockerE2eLaneArgs(["--list"])).toEqual({ kind: "list" });
    expect(parseQaDockerE2eLaneArgs(["--lane", "gateway-network"])).toEqual({
      kind: "run",
      laneName: "gateway-network",
    });

    expect(() => parseQaDockerE2eLaneArgs([])).toThrow("--lane is required");
    expect(() => parseQaDockerE2eLaneArgs(["--lane"])).toThrow("--lane requires a value");
  });

  it("renders usage from the shared lane registry", () => {
    const usage = formatQaDockerE2eLaneUsage("node qa-docker.js");

    expect(usage).toContain("Usage: node qa-docker.js --lane <name>");
    expect(usage).toContain("  - gateway-network");
    expect(usage).toContain("  - update-restart-auth");
  });

  it("resolves lane-specific environment overlays at run time", () => {
    const updateMigration = resolveQaDockerE2eLane("update-migration", {
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@custom",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "custom-scenario",
    });

    expect(updateMigration.script).toBe("scripts/e2e/upgrade-survivor-docker.sh");
    expect(updateMigration.env.OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE).toBe("1");
    expect(updateMigration.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC).toBe("openclaw@custom");
    expect(updateMigration.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO).toBe("custom-scenario");

    const updateRestartAuth = resolveQaDockerE2eLane("update-restart-auth", {});
    expect(updateRestartAuth.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE).toBe("auto-auth");
    expect(updateRestartAuth.env.OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT).toBe("1500s");
  });

  it("dispatches through bash without running Docker in fixture tests", () => {
    const spawn = vi.fn(() => ({ signal: null, status: 0 }));

    expect(runQaDockerE2eLane("gateway-network", { env: { EXTRA: "1" }, spawn })).toEqual({
      signal: null,
      status: 0,
    });

    expect(spawn).toHaveBeenCalledWith("bash", ["scripts/e2e/gateway-network-docker.sh"], {
      env: { EXTRA: "1" },
      stdio: "inherit",
    });
  });

  it("rejects unknown lanes before spawning", () => {
    const spawn = vi.fn(() => ({ signal: null, status: 0 }));

    expect(() => runQaDockerE2eLane("missing-lane", { spawn })).toThrow(
      "unknown Docker E2E lane: missing-lane",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
