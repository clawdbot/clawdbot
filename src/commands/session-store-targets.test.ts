// Session store target tests cover session-store path resolution for command surfaces.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it.each([
    ["missing", "human"],
    ["missing", "json"],
    ["directory", "human"],
    ["directory", "json"],
    ["non-database", "human"],
    ["non-database", "json"],
    ["logical-locator", "human"],
    ["logical-locator", "json"],
  ] as const)("rejects a %s explicit store in %s mode", (storeKind, mode) => {
    const dir = tempDirs.make("openclaw-explicit-session-store-");
    const storePath =
      storeKind === "missing"
        ? path.join(dir, "missing.sqlite")
        : storeKind === "directory"
          ? dir
          : storeKind === "logical-locator"
            ? path.join(dir, "sessions.json")
            : path.join(dir, "not-a-database.sqlite");
    if (storeKind === "non-database" || storeKind === "logical-locator") {
      fs.writeFileSync(storePath, "not a db");
    }
    resolveSessionStoreTargetsMock.mockReturnValue([{ agentId: "main", storePath }]);
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: { store: storePath },
      runtime,
      json: mode === "json",
    });

    expect(targets).toBeNull();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    const output = [...vi.mocked(runtime.log).mock.calls, ...vi.mocked(runtime.error).mock.calls]
      .flat()
      .join("\n");
    expect(output).toContain(storePath);
    expect(output).toMatch(/session store/iu);
    expect(output).toMatch(/pass an existing|pass a database|normalized only/iu);
    if (storeKind === "directory") {
      expect(output).not.toContain(`${storePath}.sqlite`);
    }
    if (mode === "json") {
      expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual({
        error: expect.stringContaining(storePath),
      });
      expect(runtime.error).not.toHaveBeenCalled();
    } else {
      expect(runtime.error).toHaveBeenCalledOnce();
      expect(runtime.log).not.toHaveBeenCalled();
    }
  });
});
