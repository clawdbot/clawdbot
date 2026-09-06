import { afterEach, expect, test, vi } from "vitest";
import { resolveSessionStorePathCore as resolveStorePath } from "../../config/sessions.js";
import {
  recordSessionParticipant,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test.each([
  { sessionKey: "global", transcript: false },
  { sessionKey: "unknown", transcript: false },
  { sessionKey: "global", transcript: true },
  { sessionKey: "unknown", transcript: true },
])(
  "keeps the selected unscoped $sessionKey row's owner (transcript=$transcript)",
  async ({ sessionKey, transcript }) => {
    const ownerId = ensureProfileForEmail("aggregate-owner@example.test").id;
    const cfg: OpenClawConfig = {
      session: { scope: "global" },
      agents: {
        entries: {
          main: { default: true, model: { primary: "openai/gpt-5.4" } },
          research: { model: { primary: "openai/gpt-5.5" } },
        },
      },
    };
    const storePath = resolveStorePath(undefined, { agentId: "research" });
    const sessionId = `aggregate-${sessionKey}`;
    await replaceSessionEntry(
      { agentId: "research", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 42,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: ownerId },
      },
    );
    await seedLinearSessionTranscript({
      agentId: "research",
      sessionKey,
      sessionId,
      storePath,
      contents: ["Research transcript title", "Research latest message"],
    });
    const client = identifiedClient(ownerId);
    const context = requestContext(cfg);
    const request = {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: transcript,
      includeLastMessage: transcript,
    };
    const result = await listSessions({ client, context, request });
    expect.soft(result.sessions).toHaveLength(1);
    expect.soft(result.sessions[0]).toMatchObject({
      key: sessionKey,
      sessionId,
      agentId: "research",
      modelProvider: "openai",
      model: "gpt-5.5",
      ...(transcript
        ? {
            derivedTitle: "Research transcript title",
            lastMessagePreview: "Research latest message",
          }
        : {}),
      visibility: "draft",
      sharingRole: "owner",
    });
    const searched = await listSessions({
      client,
      context,
      request: { ...request, search: "gpt-5.5" },
    });
    expect.soft(searched.sessions.map((row) => row.sessionId)).toEqual([sessionId]);
    if (sessionKey === "global") {
      const scoped = await listSessions({
        client,
        context,
        request: { ...request, agentId: "research" },
      });
      expect(scoped.sessions[0]).toMatchObject({
        agentId: "research",
        model: "gpt-5.5",
        visibility: "draft",
        sharingRole: "owner",
      });
    }
  },
);

test("a hidden-foreign role cannot discover sessions through search, batch previews, or exact resolve", async () => {
  const ownerId = ensureProfileForEmail("role-viewer@example.com").id;
  const foreignKey = "agent:main:foreign-role-read";
  const ownKey = "agent:main:own-role-read";
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  for (const [sessionKey, actorId] of [
    [foreignKey, "foreign-owner@example.com"],
    [ownKey, ownerId],
  ] as const) {
    const sessionId = `session-${sessionKey.split(":").at(-1)}`;
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 42,
        createdActor: { type: "human", source: "profile", id: actorId },
        visibility: "shared",
      },
    );
    await seedLinearSessionTranscript({
      agentId: "main",
      contents: ["hidden role search needle"],
      sessionId,
      sessionKey,
      storePath,
    });
  }
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  const client = identifiedClient(ownerId);
  const options = { client, context: { getRuntimeConfig: () => cfg } };

  const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
    "sessions.search",
    { query: "hidden role search needle" },
    options,
  );
  expect(searched.payload?.results.map((result) => result.sessionKey)).toEqual([ownKey]);

  const listed = await listSessions({
    client,
    context: requestContext(cfg),
    request: { search: "direct", includePeople: true },
  });
  expect(listed.sessions.map((row) => row.key)).toEqual([ownKey]);
  expect(listed).toMatchObject({ count: 1, totalCount: 1, peopleSessionCount: 1 });
  expect(JSON.stringify(listed)).not.toMatch(/foreign-role-read|foreign-owner/);

  const previews = await directSessionReq<{
    previews: Array<{ key: string; status: string }>;
  }>("sessions.preview", { keys: [foreignKey, ownKey] }, options);
  expect(previews.payload?.previews).toMatchObject([
    { key: foreignKey, status: "missing" },
    { key: ownKey, status: "ok" },
  ]);

  const resolved = await directSessionReq("sessions.resolve", { key: foreignKey }, options);
  expect(resolved).toMatchObject({
    ok: false,
    error: { message: `No session found: ${foreignKey}` },
  });
});

test.each(["research", "ops"] as const)(
  "searches an explicit global row using its selected owner for %s visibility",
  async (viewer) => {
    const profiles = {
      ops: ensureProfileForEmail("search-ops@example.test").id,
      research: ensureProfileForEmail("search-research@example.test").id,
    };
    for (const agentId of ["ops", "research"] as const) {
      const storePath = resolveStorePath(undefined, { agentId });
      const sessionId = `global-search-${agentId}`;
      await replaceSessionEntry(
        { agentId, sessionKey: "global", storePath },
        {
          sessionId,
          updatedAt: 42,
          createdActor: { type: "human", source: "profile", id: profiles[agentId] },
          visibility: "shared",
        },
      );
      await seedLinearSessionTranscript({
        agentId,
        sessionKey: "global",
        sessionId,
        storePath,
        contents: ["global owner search needle"],
      });
    }
    const cfg: OpenClawConfig = {
      session: { scope: "global" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
          },
        },
      },
    };
    const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
      "sessions.search",
      { query: "global owner search needle", sessionKeys: ["global"], agentId: "research" },
      {
        client: identifiedClient(profiles[viewer]),
        context: { getRuntimeConfig: () => cfg },
      },
    );
    expect(searched.ok).toBe(true);
    expect(searched.payload?.results.map((result) => result.sessionKey)).toEqual(
      viewer === "research" ? ["global"] : [],
    );
  },
);

test("sessions.describe and sessions.get hide foreign drafts at operator role boundaries", async () => {
  const sessionKey = "agent:main:foreign-draft-describe";
  const sessionId = "session-foreign-draft-describe";
  const profileId = (name: string) => ensureProfileForEmail(`${name}@example.com`).id;
  const ownerId = profileId("draft-owner");
  const memberId = profileId("draft-member");
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId,
      updatedAt: 42,
      createdActor: { type: "human", source: "profile", id: ownerId },
      visibility: "draft",
    },
  );
  await seedLinearSessionTranscript({
    agentId: "main",
    contents: ["foreign draft transcript"],
    sessionId,
    sessionKey,
    storePath,
  });
  expect(
    addSessionMember(
      { agentId: "main", sessionKey, storePath },
      { identityId: memberId, addedBy: ownerId, addedAt: 1 },
    ).inserted,
  ).toBe(true);
  for (let index = 0; index < 5; index += 1) {
    expect(
      recordSessionParticipant(
        { agentId: "main", sessionKey, storePath },
        { identity: { type: "profile", id: `participant-${index}` }, promptedAt: index + 1 },
      ),
    ).toBe("inserted");
  }
  const roleConfig = (others: "none" | "view" | "suggest" | "write"): OpenClawConfig => ({
    gateway: {
      roles: {
        default: "limited",
        definitions: {
          limited: {
            sessions: { others },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  });
  const admin = identifiedClient(profileId("draft-admin"));
  admin.connect!.scopes = ["operator.admin"];
  const missingProfile = identifiedClient(profileId("draft-missing-profile"));
  delete missingProfile.authenticatedUserProfile;
  const cases = [
    {
      name: "view",
      client: identifiedClient(profileId("draft-viewer")),
      cfg: roleConfig("view"),
      hidden: true,
    },
    {
      name: "suggest",
      client: identifiedClient(profileId("draft-suggester")),
      cfg: roleConfig("suggest"),
      hidden: true,
    },
    {
      name: "write",
      client: identifiedClient(profileId("draft-writer")),
      cfg: roleConfig("write"),
      hidden: true,
    },
    { name: "member", client: identifiedClient(memberId), cfg: roleConfig("write"), hidden: true },
    { name: "missing profile", client: missingProfile, cfg: roleConfig("view"), hidden: true },
    { name: "owner", client: identifiedClient(ownerId), cfg: roleConfig("view"), hidden: false },
    { name: "admin", client: admin, cfg: roleConfig("view"), hidden: false },
    {
      name: "no roles",
      client: identifiedClient(profileId("draft-outsider")),
      cfg: {},
      hidden: false,
    },
  ] as const;

  for (const { name, client, cfg, hidden } of cases) {
    const described = await directSessionReq<{
      session: { participants?: unknown[]; expandedParticipants?: unknown[] } | null;
    }>(
      "sessions.describe",
      { key: sessionKey },
      { client, context: { getRuntimeConfig: () => cfg } },
    );
    expect(described.ok, name).toBe(true);
    if (hidden) {
      expect(described.payload?.session, name).toBeNull();
    } else {
      expect(described.payload?.session?.participants, name).toHaveLength(4);
      expect(described.payload?.session?.expandedParticipants, name).toHaveLength(5);
    }
    const transcript = await directSessionReq<{ messages: Array<{ content?: unknown }> }>(
      "sessions.get",
      { key: sessionKey },
      { client, context: { getRuntimeConfig: () => cfg } },
    );
    expect(transcript.ok, name).toBe(true);
    expect(
      transcript.payload?.messages.map((message) => message.content),
      name,
    ).toEqual(hidden ? [] : ["foreign draft transcript"]);
  }

  const originalRead = sessionTranscriptReaders.readRecentSessionMessagesWithStatsAsync;
  for (const mutation of [
    { name: "visibility change", sessionId, visibility: "draft" as const },
    {
      name: "session replacement",
      sessionId: `${sessionId}-replacement`,
      visibility: "shared" as const,
    },
  ]) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 42,
        createdActor: { type: "human", source: "profile", id: ownerId },
        visibility: "shared",
      },
    );
    const readSpy = vi
      .spyOn(sessionTranscriptReaders, "readRecentSessionMessagesWithStatsAsync")
      .mockImplementationOnce(async (...args) => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          {
            sessionId: mutation.sessionId,
            updatedAt: 43,
            createdActor: { type: "human", source: "profile", id: ownerId },
            visibility: mutation.visibility,
          },
        );
        return await originalRead(...args);
      });
    try {
      const transcript = await directSessionReq<{ messages: Array<{ content?: unknown }> }>(
        "sessions.get",
        { key: sessionKey },
        { client: cases[0].client, context: { getRuntimeConfig: () => cases[0].cfg } },
      );
      expect(transcript.ok, mutation.name).toBe(true);
      expect(transcript.payload?.messages, mutation.name).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  }

  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId,
      updatedAt: 44,
      createdActor: { type: "human", source: "profile", id: ownerId },
      visibility: "shared",
    },
  );
  let currentCfg = roleConfig("view");
  const roleDriftRead = vi
    .spyOn(sessionTranscriptReaders, "readRecentSessionMessagesWithStatsAsync")
    .mockImplementationOnce(async (...args) => {
      currentCfg = roleConfig("none");
      return await originalRead(...args);
    });
  try {
    const transcript = await directSessionReq<{ messages: Array<{ content?: unknown }> }>(
      "sessions.get",
      { key: sessionKey },
      { client: cases[0].client, context: { getRuntimeConfig: () => currentCfg } },
    );
    expect(transcript.ok, "role/config change").toBe(true);
    expect(transcript.payload?.messages, "role/config change").toEqual([]);
  } finally {
    roleDriftRead.mockRestore();
  }
});
