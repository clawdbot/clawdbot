import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getTranscriptSourceProviderMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
}));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getTranscriptSourceProviderMock,
  listTranscriptSourceProviders: () => [],
}));

const tempDirs = createTempDirTracker();
const pendingStops = new Map<ReturnType<typeof createTranscriptsTool>, Set<string>>();
const note = "Keep the captured notes.";

function createHarness() {
  const stateDir = tempDirs.make("openclaw-transcript-ids-");
  const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
    await request.onUtterance({ text: note, final: true });
    return { ok: true, session: request.session };
  });
  const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async (request) => ({
    ok: true,
    sessionId: request.sessionId,
  }));
  const importTranscript = vi.fn<NonNullable<TranscriptSourceProvider["importTranscript"]>>(
    async () => [{ text: note }],
  );
  getTranscriptSourceProviderMock.mockReturnValue({
    id: "room-audio",
    name: "Room Audio",
    sourceKinds: ["live-audio", "posthoc-transcript"],
    start,
    stop,
    importTranscript,
  } satisfies TranscriptSourceProvider);
  const tool = createTranscriptsTool({ stateDir, caller: { kind: "operator", source: "local" } });
  const active = new Set<string>();
  pendingStops.set(tool, active);
  return {
    stateDir,
    databaseOptions,
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), databaseOptions),
    tool,
    active,
    start,
    stop,
    importTranscript,
  };
}

async function capture(
  harness: ReturnType<typeof createHarness>,
  action: "start" | "import",
  sessionId: string | undefined,
) {
  const result = await harness.tool.execute(action, {
    action,
    sessionId,
    providerId: "room-audio",
    transcript: note,
  });
  const handle = asOptionalRecord(result.details)?.sessionId;
  if (typeof handle !== "string") {
    throw new Error("Expected a transcript session handle");
  }
  // Only successful starts own cleanup; failed admission must retain its original error.
  if (action === "start") {
    harness.active.add(handle);
  }
  expect(asOptionalRecord(result.details)?.summaryExportError).toBeUndefined();
  return handle;
}

afterEach(async () => {
  try {
    for (const [tool, handles] of pendingStops) {
      for (const sessionId of handles) {
        await tool.execute("cleanup", { action: "stop", sessionId });
      }
    }
  } finally {
    pendingStops.clear();
    getTranscriptSourceProviderMock.mockReset();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  }
});

describe("transcripts bounded export names", () => {
  const oversizedIds = [
    { label: "256 safe bytes", sessionId: "notes-0-" + "x".repeat(248) },
    { label: "908 safe bytes", sessionId: "notes-0-" + "x".repeat(900) },
    { label: "2208 safe bytes", sessionId: "notes-0-" + "x".repeat(2200) },
    { label: "258 encoded bytes", sessionId: "x".repeat(85) + "." },
    { label: "overlong encoded device name", sessionId: "CON." + "x".repeat(100) },
  ];
  const ordinaryIds = [
    { label: "date-prefixed raw ID", sessionId: "2026-07-03/raw-id", slug: "2026-07-03-raw-id" },
    { label: "generated", sessionId: undefined, slug: undefined },
    { label: "punctuation", sessionId: "notes: room/one", slug: "notes-room-one" },
    { label: "255 safe bytes", sessionId: "x".repeat(255), slug: "x".repeat(255) },
    { label: "255 encoded bytes", sessionId: "x".repeat(84) + ".", slug: "%78".repeat(84) + "%2E" },
    { label: "2208 opaque characters", sessionId: "notes-0-" + "?".repeat(2200), slug: "notes-0" },
    { label: "dot", sessionId: ".", slug: "%2E" },
    { label: "dot-dot", sessionId: "..", slug: "%2E%2E" },
    { label: "device", sessionId: "CON", slug: "%43%4F%4E" },
  ];
  const cases = [
    {
      label: "date-prefixed import",
      sessionId: "2026-07-03/raw-id",
      slug: "2026-07-03-raw-id",
      action: "import" as const,
      exportParentExists: false,
      shortened: false,
    },
    ...oversizedIds.flatMap(({ label, sessionId }) =>
      [false, true].flatMap((exportParentExists) =>
        (["start", "import"] as const).map((action) => ({
          label,
          sessionId,
          action,
          exportParentExists,
          shortened: true,
          slug: undefined,
        })),
      ),
    ),
    ...ordinaryIds.map(({ label, sessionId, slug }) => ({
      label,
      sessionId,
      slug,
      action: "start" as const,
      exportParentExists: true,
      shortened: false,
    })),
  ];

  it.each(cases)(
    "$action round-trips $label with export parent=$exportParentExists",
    async ({ sessionId, slug, shortened, exportParentExists, action }) => {
      const harness = createHarness();
      const { stateDir, store, tool, start, stop, importTranscript, active } = harness;
      if (exportParentExists) {
        await fs.mkdir(path.join(stateDir, "transcripts", new Date().toISOString().slice(0, 10)), {
          recursive: true,
        });
      }
      const handle = await capture(harness, action, sessionId);
      expect(
        sessionId === undefined ? handle.startsWith("transcript-") : handle === sessionId,
      ).toBe(true);
      const providerSession =
        action === "start"
          ? start.mock.calls[0]?.[0].session
          : importTranscript.mock.calls[0]?.[0].session;
      expect(providerSession?.sessionId === handle).toBe(true);
      if (action === "start") {
        const stopped = await tool.execute("stop", { action: "stop", sessionId: handle });
        active.delete(handle);
        expect(asOptionalRecord(stopped.details)?.summaryExportError).toBeUndefined();
        expect(stop.mock.calls[0]?.[0].sessionId === handle).toBe(true);
      }
      closeOpenClawStateDatabaseForTest();
      const summarized = await tool.execute("summarize", {
        action: "summarize",
        sessionId: handle,
      });
      expect(asOptionalRecord(summarized.details)?.summaryExportError).toBeUndefined();
      const entry = await store.readSessionEntry(handle);
      expect(entry?.session.sessionId === handle).toBe(true);
      expect(entry?.session.stoppedAt).toBeTruthy();
      const exportedSlug = path.basename(entry!.sessionDir);
      expect(Buffer.byteLength(exportedSlug)).toBeLessThanOrEqual(255);
      if (shortened) {
        expect(exportedSlug).toMatch(/^[a-zA-Z0-9._%-]+-[a-f0-9]{64}$/);
        expect(exportedSlug.endsWith(`-${createHash("sha256").update(handle).digest("hex")}`)).toBe(
          true,
        );
      } else {
        expect(exportedSlug).toBe(slug ?? handle);
      }
      expect(entry!.selector).toBe(`${entry!.session.startedAt.slice(0, 10)}/${exportedSlug}`);
      expect((await store.readSession(entry!.selector))?.sessionId === handle).toBe(true);
      expect((await store.readSession(exportedSlug))?.sessionId === handle).toBe(true);
      const artifacts = await store.materializeSessionArtifacts(entry!.selector, "all");
      expect(
        JSON.parse(await fs.readFile(artifacts.metadataPath, "utf8")).sessionId === handle,
      ).toBe(true);
      expect(await fs.readFile(artifacts.summaryPath, "utf8")).toContain(note);
      expect(await fs.readFile(artifacts.transcriptPath, "utf8")).toContain(note);
      expect((await store.readSummary(entry!.session)).summary?.sessionId === handle).toBe(true);
    },
  );

  it("separates IDs with identical safe prefixes and different discarded punctuation", async () => {
    const harness = createHarness();
    const ids = ["?", "!"].map((suffix) => "notes-" + "x".repeat(900) + suffix);
    for (const sessionId of ids) {
      await capture(harness, "import", sessionId);
    }
    closeOpenClawStateDatabaseForTest();
    const entries = await harness.store.listSessionEntries();
    expect(new Set(entries.map((entry) => entry.selector)).size).toBe(2);
    expect(entries.every((entry) => path.basename(entry.sessionDir).startsWith("notes-"))).toBe(
      true,
    );
    for (const entry of entries) {
      const artifacts = await harness.store.materializeSessionArtifacts(entry.selector, "all");
      expect(
        JSON.parse(await fs.readFile(artifacts.metadataPath, "utf8")).sessionId ===
          entry.session.sessionId,
      ).toBe(true);
    }
  });

  it("keeps an older dated handle separate from an active next-day capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
    const harness = createHarness();
    const sessionId = "notes-" + "x".repeat(900);
    await capture(harness, "import", sessionId);
    const older = (await harness.store.listSessionEntries())[0]!;
    vi.setSystemTime(new Date("2026-07-02T10:00:00.000Z"));
    await capture(harness, "start", sessionId);
    const current = (await harness.store.listSessionEntries())[0]!;
    await harness.tool.execute("old-stop", { action: "stop", sessionId: older.selector });
    expect(harness.stop).not.toHaveBeenCalled();
    const result = await harness.tool.execute("current-stop", {
      action: "stop",
      sessionId: current.selector,
    });
    harness.active.delete(sessionId);
    expect(harness.stop.mock.calls[0]?.[0].sessionId === sessionId).toBe(true);
    expect(asOptionalRecord(result.details)?.summaryExportError).toBeUndefined();
    closeOpenClawStateDatabaseForTest();
    for (const entry of [older, current]) {
      expect((await harness.store.readSession(entry.selector))?.startedAt).toBe(
        entry.session.startedAt,
      );
      await expect(
        harness.store.materializeSessionArtifacts(entry.selector, "all"),
      ).resolves.toMatchObject({ hasSummary: true });
    }
  });

  it("preserves historical overlong identities and existing notes during finalization", async () => {
    const { store, databaseOptions } = createHarness();
    const sessionId = "notes-0-" + "x".repeat(2200);
    const session = {
      sessionId,
      startedAt: "2026-07-01T10:00:00.000Z",
      source: { providerId: "room-audio" },
    };
    const selector = `2026-07-01/${sessionId}`;
    await store.listSessionEntries();
    const { db } = openOpenClawStateDatabase(databaseOptions);
    const queries =
      getNodeSqliteKysely<Pick<DB, "meeting_transcript_sessions" | "meeting_transcript_summaries">>(
        db,
      );
    // Pre-fix admission could persist an overlong projection before an export failed.
    executeSqliteQuerySync(
      db,
      queries.insertInto("meeting_transcript_sessions").values({
        session_id: sessionId,
        started_at: session.startedAt,
        selector,
        session_slug: sessionId,
        export_key: selector,
        provider_id: session.source.providerId,
        source_json: JSON.stringify(session.source),
        title: null,
        stopped_at: null,
        metadata_json: null,
        export_manifest_json: "{}",
        export_pending_json: "[]",
        next_utterance_seq: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
      }),
    );
    await store.appendUtteranceForSession(session, { text: note, final: true });
    const summary = summarizeTranscripts({ session, utterances: [{ text: note, final: true }] });
    await store.writeSummary(summary, session);
    const markdown = "# Preserved historical notes\n\nCustom formatting stays intact.\n";
    executeSqliteQuerySync(
      db,
      queries
        .updateTable("meeting_transcript_summaries")
        .set({ markdown })
        .where("session_id", "=", sessionId),
    );
    closeOpenClawStateDatabaseForTest();

    await store.writeSession({ ...session, stoppedAt: "2026-07-01T11:00:00.000Z" });
    closeOpenClawStateDatabaseForTest();
    const entry = await store.readSessionEntry(sessionId);
    expect(entry?.session.sessionId === sessionId).toBe(true);
    expect(entry?.session.startedAt).toBe(session.startedAt);
    expect(entry?.session.stoppedAt).toBe("2026-07-01T11:00:00.000Z");
    expect(entry!.selector).toBe(`2026-07-01/${path.basename(entry!.sessionDir)}`);
    expect((await store.readSession(entry!.selector))?.sessionId === sessionId).toBe(true);
    expect(await store.readSummary(session)).toEqual({ summary, markdown });
    expect(
      (await store.readUtterancesForSession(session)).map((utterance) => utterance.text),
    ).toEqual([note]);
    const artifacts = await store.materializeSessionArtifacts(entry!.selector, "all");
    expect(await fs.readFile(artifacts.summaryPath, "utf8")).toBe(markdown);
    expect(JSON.parse(await fs.readFile(artifacts.summaryJsonPath, "utf8"))).toEqual(summary);
    const reopened = openOpenClawStateDatabase(databaseOptions).db;
    const row = executeSqliteQuerySync(
      reopened,
      getNodeSqliteKysely<Pick<DB, "meeting_transcript_sessions">>(reopened)
        .selectFrom("meeting_transcript_sessions")
        .select(["session_slug", "export_key"])
        .where("session_id", "=", sessionId),
    ).rows[0];
    expect(row).toEqual({
      session_slug: path.basename(artifacts.sessionDir),
      export_key: entry!.selector.toLowerCase(),
    });
  });
});
