import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail, resolveUserProfileId } from "../state/user-profiles.js";
import type { GatewayClient } from "./server-methods/types.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createSessionListEntryFilter } from "./session-sharing.js";

const roots = createTempDirTracker();
let stateRoot: string;
beforeEach(() => {
  stateRoot = roots.make("activity-profile-reference-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  roots.cleanup();
});

function createProfile(id: string): void {
  const profile = ensureProfileForEmail(`${id}@activity.test`);
  const { db } = openOpenClawStateDatabase();
  // Deterministic IDs exercise real prefix collisions without weakening the UUID producer.
  db.prepare("UPDATE user_profiles SET id = ? WHERE id = ?").run(id, profile.id);
  db.prepare("UPDATE user_profile_emails SET profile_id = ? WHERE profile_id = ?").run(
    id,
    profile.id,
  );
}

function listActivity(
  profileIds: string[],
  involvingProfileId: string,
  options: Partial<SessionsListParams> = {},
) {
  return listSessionFixture({
    cfg: {},
    storePath: stateRoot,
    store: Object.fromEntries(
      profileIds.map((id, index) => [
        `agent:main:activity-${index}`,
        {
          sessionId: `activity-${index}`,
          updatedAt: Date.now(),
          participants: [{ identity: { type: "profile" as const, id } }],
        },
      ]),
    ),
    opts: { includePeople: true, involvingProfileId, ...options },
  });
}

it("resolves short person references across UUID boundaries before session pagination", async () => {
  const selected = "12345678-a123-4123-8123-123456789abc";
  const other = "87654321-b123-4123-8123-123456789abc";
  createProfile(selected);
  createProfile(other);
  for (const length of [8, 9, 12, 13, 16, 17, 20, 21, 32]) {
    const reference = selected.replaceAll("-", "").slice(0, length);
    const result = await listActivity([other, selected, selected], reference, { limit: 1 });
    expect(result.involvingProfileId, reference).toBe(selected);
    expect(result.totalCount, reference).toBe(2);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.participants?.[0]?.identity.id).toBe(selected);
  }
  expect(resolveUserProfileId("12345678")).toBeUndefined();
});

it("rejects an ambiguous person reference even when only one matching profile has visible sessions", async () => {
  const first = "12345678-a123-4123-8123-123456789abc";
  const second = "12345678-b123-4123-8123-123456789abc";
  createProfile(first);
  createProfile(second);
  await expect(listActivity([first], "12345678")).rejects.toThrow(
    "Person link is ambiguous. Use a longer profile ID in the Activity URL.",
  );
  expect((await listActivity([first, second], "12345678a")).involvingProfileId).toBe(first);
});

it("keeps old person references working after profile merges and counts merge aliases once", async () => {
  const first = "12345678-a123-4123-8123-123456789abc";
  const second = "12345678-b123-4123-8123-123456789abc";
  const target = "87654321-c123-4123-8123-123456789abc";
  for (const id of [first, second, target]) {
    createProfile(id);
  }
  linkEmail(`${first}@activity.test`, target);
  linkEmail(`${second}@activity.test`, target);
  for (const reference of ["12345678", first, second]) {
    const result = await listActivity([first, second, target], reference);
    expect(result.involvingProfileId, reference).toBe(target);
    expect(result.sessions).toHaveLength(3);
    expect(result.people).toHaveLength(1);
  }
});

it("prefers an exact profile identifier over a UUID prefix", async () => {
  const exact = "deadbeef";
  const longer = "deadbeef-a123-4123-8123-123456789abc";
  createProfile(exact);
  createProfile(longer);
  const result = await listActivity([longer, exact], exact);
  expect(result.involvingProfileId).toBe(exact);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]?.participants?.[0]?.identity.id).toBe(exact);
});

it("retains a resolved person when search matches no sessions without resolving missing people", async () => {
  const selected = "12345678-a123-4123-8123-123456789abc";
  createProfile(selected);
  for (const reference of [selected, "12345678a123", "missing-person"]) {
    const result = await listActivity([selected], reference, { search: "no-matching-session" });
    expect(result.involvingProfileId, reference).toBe(
      reference === "missing-person" ? undefined : selected,
    );
    expect(result.sessions).toEqual([]);
    expect(result.people).toEqual([]);
  }
});

it.each(["12345678-a123-4123-8123-123456789abc", "12345678-A123-4123-8123-123456789ABC"])(
  "resolves retained profile %s without a durable row",
  async (retained) => {
    for (const reference of [
      retained,
      "12345678a123",
      retained.replaceAll("-", "").toLowerCase(),
    ]) {
      const result = await listActivity([retained], reference);
      expect(result.involvingProfileId, reference).toBe(retained);
      expect(result.sessions, reference).toHaveLength(1);
      const empty = await listActivity([retained], reference, { search: "no-matching-session" });
      expect(empty.involvingProfileId, reference).toBe(retained);
      expect(empty.sessions, reference).toEqual([]);
    }
    expect(fs.existsSync(path.join(stateRoot, "state", "openclaw.sqlite"))).toBe(false);
    createProfile("12345678-a123-4123-8123-123456789def");
    await expect(
      listActivity([retained], "12345678a123", { search: "no-matching-session" }),
    ).rejects.toThrow("Person link is ambiguous");
  },
);

it("resolves qualified retained creators without treating legacy human IDs as profiles", async () => {
  const retained = "12345678-a123-4123-8123-123456789abc";
  const result = await listSessionFixture({
    cfg: {},
    storePath: stateRoot,
    store: {
      "agent:main:qualified": {
        sessionId: "qualified",
        updatedAt: Date.now(),
        createdActor: { type: "human", id: retained, source: "profile" },
      },
      "agent:main:legacy": {
        sessionId: "legacy",
        updatedAt: Date.now(),
        createdActor: {
          type: "human",
          id: "12345678-a123-4123-8123-123456789def",
          source: "channel",
        },
      },
    },
    opts: { includePeople: true, involvingProfileId: "12345678a123" },
  });
  expect(result.involvingProfileId).toBe(retained);
  expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:qualified"]);
});

it("leaves missing and invalid person references unresolved without creating profile storage", async () => {
  for (const reference of [
    "12345678",
    "1234567",
    "ABCDEF12",
    "123456789abcdef0123456789abcdef012",
    "unknown-person",
  ]) {
    const result = await listActivity([], reference);
    expect(result.involvingProfileId).toBeUndefined();
    expect(result.sessions).toEqual([]);
  }
  expect(fs.existsSync(path.join(stateRoot, "state", "openclaw.sqlite"))).toBe(false);
});

it.each([
  { hidden: "draft", durable: false },
  { hidden: "incognito", durable: false },
  { hidden: "draft", durable: true },
  { hidden: "incognito", durable: true },
])("does not resolve hidden $hidden identities (durable=$durable)", async ({ hidden, durable }) => {
  const visibleId = "12345678-a123-4123-8123-123456789abc";
  const hiddenId = "12345678-a123-4123-8123-123456789def";
  createProfile(visibleId);
  if (durable) {
    createProfile(hiddenId);
  }
  const visibility = createSessionListEntryFilter({
    client: {
      connect: { scopes: ["operator.read"] },
      authenticatedUserProfile: { profileId: visibleId },
    } as GatewayClient,
  });
  const entryFilter = vi.fn(visibility);
  const store: Record<string, SessionEntry> = {
    "agent:main:visible": {
      sessionId: "visible",
      updatedAt: Date.now(),
      visibility: "shared",
      participants: [{ identity: { type: "profile", id: visibleId } }],
    },
    "agent:main:hidden": {
      sessionId: "hidden",
      updatedAt: Date.now(),
      visibility: hidden === "draft" ? "draft" : "shared",
      incognito: hidden === "incognito" ? true : undefined,
      participants: [{ identity: { type: "profile", id: hiddenId } }],
    },
  };
  for (const reference of ["12345678a123", hiddenId, hiddenId.replaceAll("-", "")]) {
    entryFilter.mockClear();
    const result = await listSessionFixture({
      cfg: {},
      storePath: stateRoot,
      store,
      entryFilter,
      opts: { includePeople: true, involvingProfileId: reference, search: "no-matching-session" },
    });
    expect(result.involvingProfileId, reference).toBe(
      reference === "12345678a123" ? visibleId : undefined,
    );
    expect(result.sessions).toEqual([]);
    expect(result.people).toEqual([]);
    expect(entryFilter).toHaveBeenCalledTimes(2);
  }
});

it("resolves merge aliases for visible owners without considering hidden profiles", async () => {
  const source = "12345678-a123-4123-8123-123456789abc";
  const hidden = "12345678-a123-4123-8123-123456789def";
  const target = "87654321-a123-4123-8123-123456789abc";
  for (const id of [source, hidden, target]) {
    createProfile(id);
  }
  linkEmail(`${source}@activity.test`, target);
  const entryFilter = createSessionListEntryFilter({
    client: {
      connect: { scopes: ["operator.read"] },
      authenticatedUserProfile: { profileId: target },
    } as GatewayClient,
  });
  const result = await listSessionFixture({
    cfg: {},
    storePath: stateRoot,
    entryFilter,
    store: {
      "agent:main:owned": {
        sessionId: "owned",
        updatedAt: Date.now(),
        visibility: "shared",
        owner: { actor: { type: "human", id: target } },
      },
      "agent:main:hidden": {
        sessionId: "hidden",
        updatedAt: Date.now(),
        visibility: "draft",
        participants: [{ identity: { type: "profile", id: hidden } }],
      },
    },
    opts: { includePeople: true, involvingProfileId: "12345678a123" },
  });
  expect(result.involvingProfileId).toBe(target);
  expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:owned"]);
});
