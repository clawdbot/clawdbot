import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import { toPluginJsonValue, withMSTeamsSqliteMutationLock } from "./sqlite-state.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

describe("toPluginJsonValue", () => {
  it("serializes nested BigInt values as strings", () => {
    expect(toPluginJsonValue({ id: 9007199254740993n, nested: { seq: 42n } })).toEqual({
      id: "9007199254740993",
      nested: { seq: "42" },
    });
  });

  it("replaces circular references in place while preserving serializable siblings", () => {
    const record: Record<string, unknown> = {
      id: "poll-1",
      question: "ship it?",
      options: ["yes", "no"],
      updatedAtMs: 1750000000000,
    };
    record.self = record;

    expect(toPluginJsonValue(record)).toEqual({
      id: "poll-1",
      question: "ship it?",
      options: ["yes", "no"],
      updatedAtMs: 1750000000000,
      self: "[Circular]",
    });
  });

  it("preserves repeated non-circular references", () => {
    const shared = { tag: "shared" };
    expect(toPluginJsonValue({ first: shared, second: shared })).toEqual({
      first: { tag: "shared" },
      second: { tag: "shared" },
    });
  });

  it("round-trips plain JSON values unchanged", () => {
    const value = { id: "c-1", unread: 3, pinned: true, last: null, tags: ["a", "b"] };
    expect(toPluginJsonValue(value)).toEqual(value);
  });
});

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
