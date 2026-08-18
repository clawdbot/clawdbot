import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  getSessionEntry,
  settleProvisionalParentFork,
  upsertSessionEntry,
} from "./session-store-runtime.js";

describe("provisional parent fork settlement", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-provisional-parent-fork-"), "sessions.json");
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("confirms a matching fork without refreshing activity", async () => {
    const sessionKey = "agent:main:slack:channel:c1:thread:visible";
    const updatedAt = Date.now() - 60_000;
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-visible",
        updatedAt,
        provisionalParentFork: {
          id: "slack:visible",
          parentSessionKey: "agent:main:slack:channel:c1",
          createdAt: updatedAt,
        },
      },
    });

    await expect(
      settleProvisionalParentFork({
        id: "slack:visible",
        outcome: "confirm",
        sessionKey,
        storePath,
      }),
    ).resolves.toBe("confirmed");
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "session-visible",
      updatedAt,
    });
    expect(getSessionEntry({ sessionKey, storePath })?.provisionalParentFork).toBeUndefined();
  });

  it("retires only the matching silent fork", async () => {
    const sessionKey = "agent:main:slack:channel:c1:thread:silent";
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-silent",
        updatedAt: Date.now(),
        provisionalParentFork: {
          id: "slack:silent",
          parentSessionKey: "agent:main:slack:channel:c1",
          createdAt: Date.now(),
        },
      },
    });

    await expect(
      settleProvisionalParentFork({
        id: "another-owner",
        outcome: "retire",
        sessionKey,
        storePath,
      }),
    ).resolves.toBe("mismatch");
    expect(getSessionEntry({ sessionKey, storePath })).toBeDefined();

    await expect(
      settleProvisionalParentFork({
        id: "slack:silent",
        outcome: "retire",
        sessionKey,
        storePath,
      }),
    ).resolves.toBe("retired");
    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });
});
