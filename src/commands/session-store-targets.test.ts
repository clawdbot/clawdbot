// Session store target tests cover session-store path resolution for command surfaces.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreTargets } from "./session-store-targets.js";

const resolveSessionStoreTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveSessionStoreTargets: resolveSessionStoreTargetsMock,
}));

describe("resolveSessionStoreTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates session store target resolution to the shared config helper", () => {
    resolveSessionStoreTargetsMock.mockReturnValue([
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
    ]);

    const targets = resolveSessionStoreTargets({}, {});

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
    expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, {});
  });
});
