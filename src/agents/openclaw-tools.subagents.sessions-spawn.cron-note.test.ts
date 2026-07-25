// Verifies cron-isolated sessions suppress run-mode subagent acceptance notes.
import { describe, expect, it } from "vitest";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";

describe("sessions_spawn: cron isolated session note suppression", () => {
  it("suppresses ACCEPTED_NOTE for cron isolated sessions (mode=run)", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBeUndefined();
  });

  it("preserves ACCEPTED_NOTE for regular sessions (mode=run)", () => {
    const note = resolveSubagentSpawnAcceptedNote({
      spawnMode: "run",
      agentSessionKey: "agent:main:telegram:63448508",
    });

    expect(note).toContain("Auto-announce is push-based");
  });

  it("keeps regular run guidance push-based without recommending sessions_yield", () => {
    // Run-mode children announce completion asynchronously, not through polling.
    const note = resolveSubagentSpawnAcceptedNote({ spawnMode: "run" });

    expect(note).toContain("Auto-announce is push-based");
    expect(note).toContain("Continue any independent work");
    expect(note).toContain("wait for runtime completion events to arrive as user messages");
    expect(note).toContain("only answer after completion events for ALL required children arrive");
    expect(note).not.toContain("sessions_yield");
  });

  it("preserves ACCEPTED_NOTE for non-canonical cron-like keys", () => {
    const note = resolveSubagentSpawnAcceptedNote({
      spawnMode: "run",
      agentSessionKey: "agent:main:slack:cron:job:run:uuid",
    });

    expect(note).toContain("Auto-announce is push-based");
  });

  it("preserves ACCEPTED_NOTE when agentSessionKey is undefined", () => {
    const note = resolveSubagentSpawnAcceptedNote({
      spawnMode: "run",
      agentSessionKey: undefined,
    });

    expect(note).toContain("Auto-announce is push-based");
  });

  it("uses the session note for cron session-mode spawns", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "session",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBe("thread-bound session stays active after this task; continue in-thread for follow-ups.");
  });
});
