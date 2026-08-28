import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import { withMSTeamsSqliteMutationLock } from "./sqlite-state.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

describe("MSTeams SQLite mutation lock", () => {
  let stateDir = "";

  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-msteams-lock-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("serializes concurrent mutations for the same state file", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstEntered = vi.fn();
    const secondEntered = vi.fn();
    const first = withMSTeamsSqliteMutationLock({ stateDir }, "polls", async () => {
      firstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    await vi.waitFor(() => expect(firstEntered).toHaveBeenCalledOnce());
    const second = withMSTeamsSqliteMutationLock({ stateDir }, "polls", async () => {
      secondEntered();
      return "second";
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(secondEntered).not.toHaveBeenCalled();

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(secondEntered).toHaveBeenCalledOnce();
  });
});
