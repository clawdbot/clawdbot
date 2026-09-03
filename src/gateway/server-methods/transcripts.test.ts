import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { activeSessions } from "../../agents/tools/transcripts-tool-runtime.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import { meetingTranscriptDb } from "../../transcripts/store-sqlite.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { summarizeTranscripts, type TranscriptsSummary } from "../../transcripts/summary.js";
import { transcriptsHandlers } from "./transcripts.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: () => undefined,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

beforeEach(async () => {
  const stateDir = tempDirs.make("transcripts-rpc-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  await store.writeSession(session);
});
afterEach(() => {
  activeSessions.clear();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("meeting transcript RPC", () => {
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

  it("reads canonical notes without exporting and lazily bounds the ordered utterance tail", async () => {
    const count = resolveTranscriptsConfig({}).maxUtterances + 1;
    for (let index = 0; index < count; index++) {
      await store.appendUtteranceForSession(session, {
        text: index === count - 1 ? "\u001b[31m" + "x".repeat(5000) : `line ${index}`,
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
    const withUtterances = (
      await invoke("transcripts.get", { selector, includeUtterances: true })
    )[1];
    expect(withUtterances.utterances).toHaveLength(count - 1);
    expect(withUtterances.utterances[0]).toMatchObject({ sequence: 1, text: "line 1" });
    expect(withUtterances.utterances.at(-1)).toEqual({
      sequence: count - 1,
      speakerId: "speaker",
      speakerLabel: "Ada",
      text: "x".repeat(4000),
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
