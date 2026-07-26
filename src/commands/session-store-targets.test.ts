// Session store target tests cover session-store path resolution for command surfaces.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

const resolveSessionStoreTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveSessionStoreTargets: resolveSessionStoreTargetsMock,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("resolveSessionStoreTargetsOrExit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns targets from the shared config helper", () => {
    resolveSessionStoreTargetsMock.mockReturnValue([
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
    ]);
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: {},
      runtime,
    });

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
    expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, {});
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports resolution errors and exits the command", () => {
    resolveSessionStoreTargetsMock.mockImplementation(() => {
      throw new Error("Unknown agent id: ghost");
    });
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: { agent: "ghost" },
      runtime,
    });

    expect(targets).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith("Unknown agent id: ghost");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
