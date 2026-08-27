// Create-time sessionTarget defaulting: agentTurn binds to the creating conversation.
import { describe, expect, it } from "vitest";
import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate sessionTarget defaults", () => {
  it("defaults agentTurn jobs with session context to current announce jobs", () => {
    const normalized = normalizeCronJobCreate(
      {
        name: "agent turn current default",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "hello" },
      },
      { sessionContext: { sessionKey: "agent:main:discord:channel:ops" } },
    );
    expect(normalized).toMatchObject({
      sessionTarget: "current",
      sessionKey: "agent:main:discord:channel:ops",
      delivery: { mode: "announce" },
    });
  });

  it("downgrades the agentTurn current default to isolated without session context", () => {
    const normalized = normalizeCronJobCreate({
      name: "agent turn isolated fallback",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(normalized).toMatchObject({
      sessionTarget: "isolated",
      delivery: { mode: "announce" },
    });
  });
});
