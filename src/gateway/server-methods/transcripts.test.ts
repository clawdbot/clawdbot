import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES,
  TRANSCRIPTS_RESULT_MAX_BYTES,
} from "../../../packages/gateway-protocol/src/schema/transcripts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { activeSessions, startTranscripts } from "../../transcripts/capture.js";
import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import * as transcriptProviders from "../../transcripts/provider-registry.js";
import { meetingTranscriptDb } from "../../transcripts/store-sqlite.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { summarizeTranscripts, type TranscriptsSummary } from "../../transcripts/summary.js";
import { handleGatewayRequest } from "../server-methods.js";
import { transcriptsHandlers } from "./transcripts.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const logGateway = { warn: vi.fn() };

function client(profileId?: string, scopes = ["operator.read"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}
function roles(others: "none" | "view"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "limited",
        definitions: {
          limited: { sessions: { others }, agents: ["main"], scopes: ["operator.read"] },
        },
      },
    },
  };
}
async function request(
  method: string,
  params: Record<string, unknown> = {},
  cfg: OpenClawConfig = {},
  caller = client(),
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "transcript-read", method, params },
    respond,
    client: caller,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => cfg,
      logGateway,
    } as unknown as GatewayRequestContext,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0]!;
}
async function seed(stateDir: string) {
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
  const session = {
    sessionId: "meeting",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-08-20T10:00:00.000Z",
    metadata: { agentId: "ops" },
  };
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, { text: "Archive-only text", final: true });
  return { store, session, selector: transcriptSessionSelector(session) };
}

describe("transcript Gateway read authorization and errors", () => {
  beforeEach(() => {
    logGateway.warn.mockClear();
    vi.spyOn(transcriptProviders, "getTranscriptSourceProvider").mockReturnValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns explicit byte-limit errors without a partial read or download", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { store, session, selector } = await seed(state.stateDir);
      await store.appendUtteranceForSession(session, {
        text: "x".repeat(TRANSCRIPTS_EXPORT_MAX_BYTES + 1),
      });
      for (const [method, params, type, maxBytes] of [
        [
          "transcripts.get",
          { selector, includeUtterances: true, limit: 50 },
          "transcript_result_too_large",
          TRANSCRIPTS_RESULT_MAX_BYTES,
        ],
        [
          "transcripts.export",
          { selector, format: "jsonl" },
          "transcript_export_too_large",
          TRANSCRIPTS_EXPORT_MAX_BYTES,
        ],
      ] as const) {
        const [ok, payload, error] = await request(method, params);
        expect(ok).toBe(false);
        expect(payload).toBeUndefined();
        expect(error).toMatchObject({ code: "INVALID_REQUEST", details: { type, maxBytes } });
      }
      expect(fs.existsSync(path.join(state.stateDir, "transcripts"))).toBe(false);
    });
  });

  it("keeps configured capture intent out of RPC results and durable session metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const source = { providerId: "fixture-voice", channelId: "room" };
      const cfg = { transcripts: { autoStart: [source] } };
      const provider = vi
        .spyOn(transcriptProviders, "getTranscriptSourceProvider")
        .mockReturnValue({
          id: source.providerId,
          name: "Fixture voice",
          sourceKinds: ["live-audio"],
          accessControl: {
            channelId: "discord",
            resolveAccountId: () => ({ ok: true, value: "default" }),
            authorize: async () => ({ ok: true, value: undefined }),
          },
          start: async ({ session }) => ({ ok: true, session }),
        });
      try {
        const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
        await startTranscripts({
          ctx: { config: cfg, stateDir: state.stateDir, logger: { warn: vi.fn() } },
          store,
          rawParams: { ...source, sessionId: "configured-capture" },
          configuredLifecycle: true,
        });
        const [ok, payload] = await request("transcripts.status", {}, cfg);
        expect(ok).toBe(true);
        expect(payload).toMatchObject({
          configuredSources: [{ state: "armed" }],
          active: [{ source: { accountId: "default" }, activeSubscription: true }],
        });
        expect(JSON.stringify(payload)).not.toContain('configuredSource"');
        expect(JSON.stringify(await store.readSession("configured-capture"))).not.toContain(
          "configuredSource",
        );
      } finally {
        provider.mockRestore();
        activeSessions.clear();
      }
    });
  });

  it("denies every global archive read for sessions.others:none even with allowed or forged agent filters", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { selector } = await seed(state.stateDir);
      const profile = ensureProfileForEmail("transcript-guest@example.test");
      const cfg = roles("none");
      const queries: Array<[string, Record<string, unknown>]> = [
        ["transcripts.list", {}],
        ["transcripts.list", { agentId: "main" }],
        ["transcripts.list", { agentId: "ops" }],
        ["transcripts.get", { selector }],
        ["transcripts.export", { selector, format: "jsonl" }],
        ["transcripts.status", {}],
      ];
      for (const [method, params] of queries) {
        const [ok, payload, error] = await request(method, params, cfg, client(profile.id));
        expect(ok, method).toBe(false);
        expect(payload).toBeUndefined();
        expect(error).toMatchObject({ code: "FORBIDDEN" });
      }
      expect((await request("transcripts.list", {}, cfg, client()))[2]).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(fs.existsSync(path.join(state.stateDir, "transcripts"))).toBe(false);
    });
  });

  it("preserves global reads for view roles and admins without treating the creation agent allowlist as read scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { selector } = await seed(state.stateDir);
      const profile = ensureProfileForEmail("transcript-reader@example.test");
      const caller = client(profile.id);
      const [ok, payload] = await request(
        "transcripts.list",
        { agentId: "ops" },
        roles("view"),
        caller,
      );
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        sessions: [{ selector, agentId: "ops", utteranceCount: 1 }],
      });
      expect((await request("transcripts.get", { selector }, roles("view"), caller))[0]).toBe(true);
      expect(
        (
          await request("transcripts.export", { selector, format: "jsonl" }, roles("view"), caller)
        )[1],
      ).toMatchObject({ encoding: "base64", selector });
      expect(
        (
          await request(
            "transcripts.list",
            {},
            roles("none"),
            client(profile.id, ["operator.admin"]),
          )
        )[0],
      ).toBe(true);
      expect(
        (await request("transcripts.get", { selector, agentId: "main" }, roles("view"), caller))[2],
      ).toMatchObject({ code: "INVALID_REQUEST" });
      expect(fs.existsSync(path.join(state.stateDir, "transcripts"))).toBe(false);
    });
  });

  it("does not expose hidden legacy URL content through authorized search, reads or exports", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const hidden = [
        "fixture-user-amber",
        "fixture-pass-cobalt",
        "fixture-query-violet",
        "fixture-fragment-ochre",
      ];
      const url = new URL(`https://example.test/public-room?invite=${hidden[2]}#${hidden[3]}`);
      url.username = hidden[0]!;
      url.password = hidden[1]!;
      const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
      const session = {
        sessionId: "public-session",
        title: "Public planning",
        source: {
          providerId: "fixture-provider",
          channelId: "public-channel",
          meetingUrl: url.href,
        },
        startedAt: "2026-08-20T10:00:00.000Z",
      };
      await store.writeSession(session);
      await store.appendUtteranceForSession(session, {
        text: "Synthetic planning note",
        final: true,
      });
      const profile = ensureProfileForEmail("url-reader@example.test");
      const caller = client(profile.id);
      closeOpenClawStateDatabaseForTest();
      const selector = transcriptSessionSelector(session);
      const publicOutputs: string[] = [];
      for (const query of ["PLANNING", "public-session", "public-channel", "fixture-provider"]) {
        const [ok, payload] = await request("transcripts.list", { query }, roles("view"), caller);
        expect(ok).toBe(true);
        expect(payload).toMatchObject({
          sessions: [{ selector, source: { meetingUrl: "https://example.test/public-room" } }],
        });
        publicOutputs.push(JSON.stringify(payload));
      }
      for (const query of hidden.flatMap((part) => [part, part.slice(0, -3).toUpperCase()])) {
        const [ok, payload] = await request("transcripts.list", { query }, roles("view"), caller);
        expect(ok).toBe(true);
        expect(payload, query).toMatchObject({ sessions: [], nextCursor: null });
      }
      for (const query of ["planning", hidden[0]]) {
        const denied = await request("transcripts.list", { query }, roles("none"), caller);
        expect(denied[0]).toBe(false);
        expect(denied[1]).toBeUndefined();
        expect(denied[2]).toMatchObject({ code: "FORBIDDEN" });
        const missingScope = await request(
          "transcripts.list",
          { query },
          roles("view"),
          client(profile.id, []),
        );
        expect(missingScope[0]).toBe(false);
        expect(missingScope[2]?.details).toMatchObject({ missingScope: "operator.read" });
      }
      const [ok, read] = await request(
        "transcripts.get",
        { selector, includeUtterances: true },
        roles("view"),
        caller,
      );
      expect(ok).toBe(true);
      expect(read).toMatchObject({
        session: { source: { meetingUrl: "https://example.test/public-room" } },
        utterances: [{ text: "Synthetic planning note" }],
      });
      publicOutputs.push(JSON.stringify(read));
      for (const format of ["markdown", "jsonl"] as const) {
        const [exported, payload] = await request(
          "transcripts.export",
          { selector, format },
          roles("view"),
          caller,
        );
        expect(exported).toBe(true);
        expect(payload).toMatchObject({ selector, encoding: "base64" });
        const content = Buffer.from((payload as { data: string }).data, "base64").toString("utf8");
        expect(content).toContain("Synthetic planning note");
        publicOutputs.push(content);
      }
      for (const output of publicOutputs) {
        for (const part of hidden) {
          expect(output).not.toContain(part);
        }
      }
      expect((await store.readSession(selector))?.source.meetingUrl).toBe(url.href);
    });
  });

  it("uses the normal operator role and scope fence and never advertises a capture mutation method", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (const [method, params] of [
        ["transcripts.list", {}],
        ["transcripts.get", { selector: "missing" }],
        ["transcripts.export", { selector: "missing", format: "markdown" }],
        ["transcripts.status", {}],
      ] as const) {
        const denied = await request(method, params, {}, client(undefined, ["operator.questions"]));
        expect(denied[0]).toBe(false);
        expect(denied[2]?.details).toMatchObject({ missingScope: "operator.read" });
        const node = client(undefined, ["operator.admin"]);
        node.connect.role = "node";
        expect((await request(method, params, {}, node))[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: "unauthorized role: node",
        });
      }
      expect(
        (await request("transcripts.start", {}, {}, client(undefined, ["operator.admin"])))[0],
      ).toBe(false);
      expect(
        (await request("transcripts.list", {}, {}, client(undefined, ["operator.write"])))[0],
      ).toBe(true);
    });
  });

  it("waits for the authenticated profile before reading the library", async () => {
    const caller = client();
    caller.authenticatedUserId = "pending@example.test";
    caller.authenticatedGitHubIdentitySync = vi
      .fn()
      .mockRejectedValue(new Error("private identity detail"));
    const result = await request("transcripts.status", {}, roles("view"), caller);
    expect(result[2]).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("private identity detail");
  });

  it("rejects invalid requests and missing selectors, and redacts archive failures", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { session, selector } = await seed(state.stateDir);
      for (const [method, params] of [
        ["transcripts.list", { limit: 201 }],
        ["transcripts.list", { query: "x".repeat(257) }],
        ["transcripts.list", { startedAfter: "not-a-date" }],
        ["transcripts.get", { selector, limit: 0 }],
        ["transcripts.export", { selector, format: "audio" }],
        ["transcripts.status", { enabled: false }],
      ] as const) {
        expect((await request(method, params))[2]).toMatchObject({ code: "INVALID_REQUEST" });
      }
      for (const method of ["transcripts.get", "transcripts.export"]) {
        const params = {
          selector: "missing",
          ...(method.endsWith("export") ? { format: "jsonl" } : {}),
        };
        expect((await request(method, params))[2]).toMatchObject({
          code: "INVALID_REQUEST",
          details: { type: "transcript_session_not_found" },
        });
      }
      expect(logGateway.warn).not.toHaveBeenCalled();
      const { db } = openOpenClawStateDatabase();
      executeSqliteQuerySync(
        db,
        meetingTranscriptDb(db)
          .updateTable("meeting_transcript_sessions")
          .set({ source_json: "private corrupt source /host/private/path" })
          .where("session_id", "=", session.sessionId),
      );
      const result = await request("transcripts.get", { selector });
      expect(result[2]).toMatchObject({ code: "UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain("/host/private/path");
      expect(logGateway.warn).toHaveBeenCalledWith(
        expect.stringMatching(/transcripts\.get failed: SyntaxError/),
      );
    });
  });
});

describe("meeting transcript RPC", () => {
  let store: TranscriptsStore;

  const session = {
    sessionId: "weekly",
    title: "Design review",
    startedAt: "2026-08-02T14:00:00.000Z",
    source: {
      providerId: "manual-transcript",
      guildId: "team",
      meetingUrl: "https://example.com/meeting?token=secret#secret",
      privateField: "hidden",
    },
    metadata: { privateMetadata: "hidden" },
  };

  async function invoke(method: string, params: Record<string, unknown>) {
    const respond = vi.fn();
    const handler = transcriptsHandlers[method];
    if (!handler) {
      throw new Error(`missing handler: ${method}`);
    }
    await handler({
      req: { type: "req", id: "test", method },
      params,
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
    });
    expect(respond).toHaveBeenCalledOnce();
    const response = respond.mock.calls[0];
    if (!response) {
      throw new Error(`missing response: ${method}`);
    }
    return response;
  }

  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    const stateDir = state.stateDir;
    vi.spyOn(transcriptProviders, "getTranscriptSourceProvider").mockReturnValue(undefined);
    store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await store.writeSession(session);
  });
  afterEach(async () => {
    activeSessions.clear();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it("lists exact capture counts, first-appearance speakers, and sanitized source fields", async () => {
    const older = { ...session, startedAt: "2026-08-01T14:00:00.000Z" };
    await store.writeSession(older);
    await store.appendUtteranceForSession(older, {
      text: "older",
      speaker: { label: "Old speaker" },
    });
    for (const label of ["Zoe", "Ada", "Zoe"]) {
      await store.appendUtteranceForSession(session, { text: "Agreed.", speaker: { label } });
    }
    await store.appendUtteranceForSession(session, { text: "Unattributed" });
    const storedSummary = {
      ...summarizeTranscripts({ session, utterances: [] }),
      overview: "x".repeat(400),
      source: "model",
      participants: ["Zoe", "Ada"],
      model: "gpt-5.6-luna",
    } satisfies TranscriptsSummary;
    await store.writeSummary(storedSummary, session);
    activeSessions.set(session.sessionId, {
      session,
      providerId: "manual-transcript",
      provider: {},
      phase: "active",
    });
    const [ok, payload] = await invoke("transcripts.list", {});
    expect(ok).toBe(true);
    expect(payload.sessions).toHaveLength(2);
    expect(payload.sessions[0]).toMatchObject({
      utteranceCount: 4,
      participants: ["Zoe", "Ada"],
      active: true,
      hasSummary: true,
      summarySource: "model",
      overview: "x".repeat(280),
    });
    expect(payload.sessions[0].source).toEqual({
      providerId: "manual-transcript",
      guildId: "team",
      meetingUrl: "https://example.com/meeting",
    });
    expect(payload.sessions[0]).not.toHaveProperty("metadata");
    expect(payload.sessions[1]).toMatchObject({
      utteranceCount: 1,
      participants: ["Old speaker"],
      active: false,
      hasSummary: false,
    });
    expect((await invoke("transcripts.list", { limit: 1 }))[1].sessions).toHaveLength(1);
    expect((await invoke("transcripts.list", { providerId: "absent" }))[1].sessions).toEqual([]);
  });

  it("reads canonical notes without exporting and paginates full ordered utterances", async () => {
    const count = resolveTranscriptsConfig({}).maxUtterances + 1;
    const finalSpeech = "x".repeat(3999) + "😀" + "x".repeat(1000);
    for (let index = 0; index < count; index++) {
      await store.appendUtteranceForSession(session, {
        id: `speech-${index}`,
        text:
          index === count - 1
            ? "\u001b[31m" + finalSpeech
            : `line ${index}` + (index < 2 ? "" : "x".repeat(600)),
        speaker: { id: "speaker", label: "Ada" },
        final: true,
        metadata: { private: true },
      });
    }
    const summary = {
      ...summarizeTranscripts({ session, utterances: [{ text: "Agreed to ship." }] }),
      participants: ["Ada"],
      source: "heuristic",
    } satisfies TranscriptsSummary;
    await store.writeSummary(summary, session);
    const selector = transcriptSessionSelector(session);
    const payload = (await invoke("transcripts.get", { selector }))[1];
    expect(payload.summary.markdown.trimEnd()).toBe(
      (await store.readSummary(session)).markdown?.trimEnd(),
    );
    expect(payload.summary.participants).toEqual(["Ada"]);
    expect(payload.utterances).toBeUndefined();
    const [recentRead, recent] = await invoke("transcripts.get", {
      selector,
      includeUtterances: true,
    });
    expect(recentRead).toBe(true);
    expect(recent.utterances).toHaveLength(count - 1);
    expect(recent.utterances[0]).toMatchObject({ sequence: 1, text: "line 1" });
    expect(recent.utterances.at(-1)).toEqual({
      sequence: count - 1,
      speakerId: "speaker",
      speakerLabel: "Ada",
      text: "x".repeat(3999),
      final: true,
    });
    expect(recent.nextCursor).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(recent))).toBeGreaterThan(1024 * 1024);
    const [, searched] = await invoke("transcripts.get", {
      selector,
      includeUtterances: true,
      query: "line",
    });
    expect(searched.utterances).toHaveLength(50);
    expect(searched.utterances[0]).toMatchObject({ sequence: 0 });
    const [, first] = await invoke("transcripts.get", {
      selector,
      includeUtterances: true,
      limit: 1,
    });
    const [, next] = await invoke("transcripts.get", {
      selector,
      includeUtterances: true,
      cursor: first.nextCursor,
    });
    expect(next.utterances).toHaveLength(50);
    expect(next.utterances[0]).toMatchObject({ sequence: 1 });
    const utterances: Array<{ sequence: number; text: string }> = [];
    let cursor: string | null = null;
    do {
      const [read, page] = await invoke("transcripts.get", {
        selector,
        includeUtterances: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      expect(read).toBe(true);
      expect(page.utterances.length).toBeLessThanOrEqual(100);
      utterances.push(...page.utterances);
      cursor = page.nextCursor;
    } while (cursor);
    expect(utterances).toHaveLength(count);
    expect(utterances[0]).toMatchObject({ sequence: 0, text: "line 0" });
    expect(utterances.at(-1)).toEqual({
      sequence: count - 1,
      id: `speech-${count - 1}`,
      speakerId: "speaker",
      speakerLabel: "Ada",
      text: finalSpeech,
      final: true,
    });
  });

  it("reads older stored notes without participant or model attribution fields", async () => {
    const summary = summarizeTranscripts({ session, utterances: [{ text: "Legacy notes." }] });
    await store.writeSummary(summary, session);
    const database = openOpenClawStateDatabase().db;
    executeSqliteQuerySync(
      database,
      meetingTranscriptDb(database)
        .updateTable("meeting_transcript_summaries")
        .set({
          summary_json: JSON.stringify({ ...summary, participants: undefined, source: undefined }),
        })
        .where("session_id", "=", session.sessionId)
        .where("session_started_at", "=", session.startedAt),
    );
    const [ok, payload] = await invoke("transcripts.get", {
      selector: transcriptSessionSelector(session),
    });
    expect(ok).toBe(true);
    expect(payload.summary).toMatchObject({ overview: "Legacy notes.", participants: [] });
    expect(payload.summary.source).toBeUndefined();
    expect(payload.summary.model).toBeUndefined();
  });

  it("returns an intentional no-summary result and typed not-found errors", async () => {
    const [ok, payload] = await invoke("transcripts.get", {
      selector: transcriptSessionSelector(session),
    });
    expect(ok).toBe(true);
    expect(payload.session.hasSummary).toBe(false);
    expect(payload.summary).toBeUndefined();
    expect(await invoke("transcripts.get", { selector: "missing" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", details: { type: "transcript_session_not_found" } },
    ]);
  });

  it.each([{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { unexpected: true }])(
    "rejects invalid list params %j",
    async (params) => {
      expect((await invoke("transcripts.list", params))[0]).toBe(false);
    },
  );
});
