import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const getUserProfileListItem = vi.hoisted(() =>
  vi.fn((profileId: string) => ({
    id: profileId,
    displayName: profileId === "profile-ada" ? "Ada" : "Bob",
  })),
);

vi.mock("../state/user-profiles.js", () => ({ getUserProfileListItem }));

import { listSessionsFromStore } from "./session-utils.js";

it("returns the complete deterministic creator facet independently of pagination", () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:ada": {
      archivedAt: 3,
      archivedBy: { type: "human", id: "profile-bob" },
      createdActor: { type: "human", id: "profile-ada" },
      sessionId: "session-ada",
      updatedAt: 2,
    },
    "agent:main:bob": {
      createdActor: { type: "human", id: "profile-bob" },
      sessionId: "session-bob",
      updatedAt: 1,
    },
  };

  const result = listSessionsFromStore({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-creators",
    store,
    opts: { archived: "all", limit: 1 },
  });

  expect(result.count).toBe(1);
  expect(result.totalCount).toBe(2);
  expect(result.creators).toEqual([
    { id: "profile-ada", label: "Ada" },
    { id: "profile-bob", label: "Bob" },
  ]);
  expect(result.sessions[0]?.createdActor).toEqual({
    type: "human",
    id: "profile-ada",
    label: "Ada",
  });
  expect(result.sessions[0]?.archivedBy).toEqual({
    type: "human",
    id: "profile-bob",
    label: "Bob",
  });
  expect(getUserProfileListItem).toHaveBeenCalledTimes(2);

  const filtered = listSessionsFromStore({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-creators",
    store,
    opts: { archived: "all", creatorId: "profile-bob", limit: 1 },
  });
  expect(filtered.sessions.map((row) => row.key)).toEqual(["agent:main:bob"]);
  expect(filtered.creators).toEqual(result.creators);
});
