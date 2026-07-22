import { expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listSessionsFromStore } from "./session-utils.js";

it("returns the complete deterministic creator facet independently of pagination", () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:ada": {
      createdBy: { id: "profile-ada", label: "Ada" },
      sessionId: "session-ada",
      updatedAt: 2,
    },
    "agent:main:bob": {
      createdBy: { id: "profile-bob", label: "Bob" },
      sessionId: "session-bob",
      updatedAt: 1,
    },
  };

  const result = listSessionsFromStore({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-creators",
    store,
    opts: { limit: 1 },
  });

  expect(result.count).toBe(1);
  expect(result.totalCount).toBe(2);
  expect(result.creators).toEqual([
    { id: "profile-ada", label: "Ada" },
    { id: "profile-bob", label: "Bob" },
  ]);

  const filtered = listSessionsFromStore({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-creators",
    store,
    opts: { creatorId: "profile-bob", limit: 1 },
  });
  expect(filtered.sessions.map((row) => row.key)).toEqual(["agent:main:bob"]);
  expect(filtered.creators).toEqual(result.creators);
});
