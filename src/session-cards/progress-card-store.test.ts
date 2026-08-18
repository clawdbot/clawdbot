import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL } from "../state/openclaw-agent-progress-card-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { readSessionProgressCard, writeSessionProgressCard } from "./progress-card-store.js";

const SESSION_KEY = "agent:main:main";
const STEPS = [
  { step: "Inspect", status: "completed" as const },
  { step: "Patch", status: "in_progress" as const },
];

describe("session progress card store", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(SESSION_KEY, "session-1", JSON.stringify({ sessionId: "session-1" }), 1);
  });

  afterEach(() => db.close());

  it.each([
    { name: "markdown only", input: { markdown: "Working" }, expected: { markdown: "Working" } },
    { name: "plan only", input: { steps: STEPS }, expected: { steps: STEPS } },
    {
      name: "markdown and plan",
      input: { markdown: "Working", steps: STEPS },
      expected: { markdown: "Working", steps: STEPS },
    },
  ])("roundtrips $name", ({ input, expected }) => {
    const written = writeSessionProgressCard(db, SESSION_KEY, input);

    expect(written).toEqual({
      card: expect.objectContaining({
        sessionKey: SESSION_KEY,
        revision: 1,
        ...expected,
      }),
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toEqual(
      expect.objectContaining({ sessionKey: SESSION_KEY, revision: 1, ...expected }),
    );
  });

  it("replaces the whole card, advances its revision, and clears on empty input", () => {
    writeSessionProgressCard(db, SESSION_KEY, { markdown: "First", steps: STEPS });
    expect(writeSessionProgressCard(db, SESSION_KEY, { markdown: "Second" })).toEqual({
      card: {
        sessionKey: SESSION_KEY,
        markdown: "Second",
        revision: 2,
        updatedAt: expect.any(Number),
      },
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toEqual(
      expect.objectContaining({ markdown: "Second", revision: 2 }),
    );
    expect(readSessionProgressCard(db, SESSION_KEY)?.steps).toBeUndefined();

    expect(writeSessionProgressCard(db, SESSION_KEY, { markdown: "  \n ", steps: [] })).toEqual({
      cleared: true,
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
  });

  it("treats a missing lazy table as no card without creating it", () => {
    db.close();
    db = new DatabaseSync(":memory:");
    db.exec(AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL);

    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("session_progress_cards"),
    ).toBeUndefined();
  });

  it("deletes the card when its owning session node is deleted", () => {
    writeSessionProgressCard(db, SESSION_KEY, { markdown: "Owned by the session" });

    db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(SESSION_KEY);

    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
  });
});
