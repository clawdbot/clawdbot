import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, type SessionState } from "./session-state.js";
import { createSoftLCT } from "./soft-lct.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".test-session-tmp");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function makeState(sessionId = "test-sess"): SessionState {
  return {
    sessionId,
    lct: createSoftLCT(sessionId),
    actionIndex: 0,
    startedAt: new Date().toISOString(),
    toolCounts: {},
    categoryCounts: {},
  };
}

describe("SessionStore", () => {
  afterEach(cleanup);

  it("should create sessions directory on construction", () => {
    cleanup();
    new SessionStore(TEST_DIR);
    expect(existsSync(join(TEST_DIR, "sessions"))).toBe(true);
  });

  it("should save and load a session state", () => {
    cleanup();
    const store = new SessionStore(TEST_DIR);
    const state = makeState("s1");
    store.save(state);

    const loaded = store.load("s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("s1");
    expect(loaded!.lct.bindingType).toBe("software");
  });

  it("should return null for nonexistent session", () => {
    cleanup();
    const store = new SessionStore(TEST_DIR);
    expect(store.load("nope")).toBeNull();
  });

  it("should persist as JSON file", () => {
    cleanup();
    const store = new SessionStore(TEST_DIR);
    store.save(makeState("s1"));

    const filePath = join(TEST_DIR, "sessions", "s1.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.sessionId).toBe("s1");
  });

  it("should increment action and persist", () => {
    cleanup();
    const store = new SessionStore(TEST_DIR);
    const state = makeState("s1");
    store.save(state);

    store.incrementAction(state, "Read", "file_read", "r6:001");
    expect(state.actionIndex).toBe(1);
    expect(state.lastR6Id).toBe("r6:001");
    expect(state.toolCounts["Read"]).toBe(1);
    expect(state.categoryCounts["file_read"]).toBe(1);

    store.incrementAction(state, "Read", "file_read", "r6:002");
    expect(state.actionIndex).toBe(2);
    expect(state.toolCounts["Read"]).toBe(2);

    store.incrementAction(state, "Write", "file_write", "r6:003");
    expect(state.toolCounts["Write"]).toBe(1);
    expect(state.categoryCounts["file_write"]).toBe(1);

    // Verify persisted
    const loaded = store.load("s1");
    expect(loaded!.actionIndex).toBe(3);
    expect(loaded!.lastR6Id).toBe("r6:003");
  });
});
