import { describe, expect, it } from "vitest";
import {
  resolveSubagentSpawnAcceptedNote,
  SUBAGENT_SPAWN_ACCEPTED_NOTE,
  SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE,
} from "./subagent-spawn-accepted-note.js";

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
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:telegram:63448508",
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("preserves ACCEPTED_NOTE for non-canonical cron-like keys", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:slack:cron:job:run:uuid",
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("preserves ACCEPTED_NOTE when agentSessionKey is undefined", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: undefined,
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("uses the session note for cron session-mode spawns", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "session",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBe(SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE);
  });
});
