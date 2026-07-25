import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { safeTranscriptPathSegment, TranscriptsStore } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function createStore(): { stateDir: string; store: TranscriptsStore } {
  const stateDir = tempDirs.make("openclaw-transcript-test-");
  return {
    stateDir,
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    }),
  };
}

function session(
  sessionId = "session-1",
  startedAt = "2026-07-01T10:00:00.000Z",
): TranscriptSessionDescriptor {
  return {
    sessionId,
    source: { providerId: "manual-transcript" },
    startedAt,
  };
}

describe("TranscriptsStore", () => {
  it("encodes portable slugs for Windows-reserved and trailing-dot IDs", () => {
    expect(safeTranscriptPathSegment("CON")).toBe("%43%4F%4E");
    expect(safeTranscriptPathSegment("foo.")).toBe("%66%6F%6F%2E");
    expect(safeTranscriptPathSegment("foo")).toBe("foo");
  });

  it("persists sessions and utterances only in SQLite until export", async () => {
    const { stateDir, store } = createStore();
    const target = session();

    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "hello", final: true });
    await store.appendUtteranceForSession(target, { text: "world", final: true });

    expect(await store.readSession(target.sessionId)).toEqual(target);
    expect(await store.readUtterancesForSession(target)).toEqual([
      { sessionId: target.sessionId, text: "hello", final: true },
      { sessionId: target.sessionId, text: "world", final: true },
    ]);
    expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
  });

  it("returns the requested ordered utterance tail", async () => {
    const { store } = createStore();
    const target = session();
    await store.writeSession(target);
    for (let index = 0; index < 5; index += 1) {
      await store.appendUtteranceForSession(target, { text: `line-${index}` });
    }

    await expect(store.readUtterancesForSession(target, { maxUtterances: 2 })).resolves.toEqual([
      expect.objectContaining({ text: "line-3" }),
      expect.objectContaining({ text: "line-4" }),
    ]);
  });

  it("deduplicates exact retries but preserves same-id revisions", async () => {
    const { store } = createStore();
    const target = session();
    const interim = { id: "utterance-1", text: "draft", final: false };
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, interim);
    await store.appendUtteranceForSession(target, interim);
    const final = {
      id: "utterance-1",
      text: "final text",
      final: true,
    };
    await store.appendUtteranceForSession(target, final);
    await store.appendUtteranceForSession(target, interim);
    await store.appendUtteranceForSession(target, final);

    await expect(store.readUtterancesForSession(target)).resolves.toMatchObject([
      interim,
      { id: "utterance-1", text: "final text", final: true },
    ]);
  });

  it("requires date-qualified selectors for repeated ids", async () => {
    const { store } = createStore();
    await store.writeSession(session("standup", "2026-07-01T10:00:00.000Z"));
    await store.writeSession(session("standup", "2026-07-02T10:00:00.000Z"));

    await expect(store.readSession("standup")).rejects.toThrow(
      "multiple transcripts sessions match standup",
    );
    await expect(store.readSession("2026-07-01/standup")).resolves.toMatchObject({
      startedAt: "2026-07-01T10:00:00.000Z",
    });
  });

  it("matches bare selector slugs literally and case-sensitively", async () => {
    const { store } = createStore();
    await store.writeSession(session("fooXbar"));
    await store.writeSession(session("Capital", "2026-07-02T10:00:00.000Z"));
    await store.writeSession(session("foo@bar", "2026-07-03T10:00:00.000Z"));
    await store.writeSession(session("foo-bar", "2026-07-04T10:00:00.000Z"));

    await expect(store.readSession("foo_bar")).resolves.toBeUndefined();
    await expect(store.readSession("capital")).resolves.toBeUndefined();
    await expect(store.readSession("foo#bar")).resolves.toBeUndefined();
    await expect(store.readSession("foo@bar")).resolves.toMatchObject({ sessionId: "foo@bar" });
    await expect(store.readSession("foo-bar")).rejects.toThrow(
      "multiple transcripts sessions match foo-bar",
    );
  });

  it("round-trips empty nullable text values", async () => {
    const { store } = createStore();
    const target = { ...session("empty-values"), title: "" };
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, {
      id: "",
      speaker: { id: "", label: "" },
      text: "",
    });

    await expect(store.readSession("empty-values")).resolves.toEqual(target);
    await expect(store.readUtterancesForSession(target)).resolves.toEqual([
      { id: "", sessionId: "empty-values", speaker: { id: "", label: "" }, text: "" },
    ]);
  });

  it("rejects two session identities that map to one shipped selector", async () => {
    const { store } = createStore();
    await store.writeSession(session("standup", "2026-07-01T10:00:00.000Z"));

    await expect(
      store.writeSession(session("standup", "2026-07-01T11:00:00.000Z")),
    ).rejects.toThrow();
  });

  it("stores case-distinct sessions and rejects only unsafe export collisions", async () => {
    const { store } = createStore();
    const upper = session("Capital", "2026-07-01T10:00:00.000Z");
    const lower = session("capital", "2026-07-01T11:00:00.000Z");
    await store.writeSession(lower);
    await store.materializeSessionArtifacts(lower, "metadata");
    await expect(store.writeSession(upper)).resolves.toBeUndefined();

    if (fs.existsSync(store.sessionDir(upper))) {
      await expect(store.materializeSessionArtifacts(lower, "metadata")).resolves.toMatchObject({
        metadataPath: path.join(store.sessionDir(lower), "metadata.json"),
      });
      await expect(store.materializeSessionArtifacts(upper, "metadata")).rejects.toThrow(
        "collides case-insensitively",
      );
    } else {
      await expect(store.materializeSessionArtifacts(upper, "metadata")).resolves.toMatchObject({
        metadataPath: path.join(store.sessionDir(upper), "metadata.json"),
      });
    }
  });

  it("uses remaining manifest artifacts when aliased export metadata is absent", async () => {
    const { store } = createStore();
    const upper = session("Capital", "2026-07-01T10:00:00.000Z");
    const lower = session("capital", "2026-07-01T11:00:00.000Z");
    await store.writeSession(upper);
    await store.appendUtteranceForSession(upper, { text: "owned transcript" });
    const artifacts = await store.materializeSessionArtifacts(upper, "transcript");
    fs.rmSync(artifacts.metadataPath);

    await expect(store.writeSession(lower)).resolves.toBeUndefined();
  });

  it("does not let a case-distinct SQLite owner mask a legacy directory", async () => {
    const { stateDir, store } = createStore();
    const upper = session("Capital", "2026-07-01T10:00:00.000Z");
    const lower = session("capital", "2026-07-01T11:00:00.000Z");
    await store.writeSession(upper);
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } })
      .db.prepare(
        "UPDATE meeting_transcript_sessions SET export_pending_json = ? WHERE session_id = ?",
      )
      .run('["metadata.json","transcript.jsonl"]', upper.sessionId);
    fs.mkdirSync(store.sessionDir(lower), { recursive: true });
    fs.writeFileSync(path.join(store.sessionDir(lower), "transcript.jsonl"), "legacy\n");

    await expect(store.writeSession(lower)).rejects.toThrow("run openclaw doctor --fix");
    await expect(store.readSession(lower.sessionId)).resolves.toBeUndefined();
  });

  it("recognizes case-variant artifact names only when the filesystem aliases them", async () => {
    const { store } = createStore();
    const upper = session("Capital", "2026-07-01T10:00:00.000Z");
    const lower = session("capital", "2026-07-01T11:00:00.000Z");
    await store.writeSession(upper);
    expect(fs.existsSync(store.sessionDir(upper))).toBe(false);
    fs.mkdirSync(store.sessionDir(lower), { recursive: true });
    fs.rmSync(path.join(store.sessionDir(lower), "transcript.jsonl"), { force: true });
    fs.writeFileSync(path.join(store.sessionDir(lower), "TRANSCRIPT.JSONL"), "legacy\n");
    expect(fs.readdirSync(store.sessionDir(lower))).toContain("TRANSCRIPT.JSONL");

    if (fs.existsSync(path.join(store.sessionDir(lower), "transcript.jsonl"))) {
      await expect(store.writeSession(lower)).rejects.toThrow("run openclaw doctor --fix");
    } else {
      await expect(store.writeSession(lower)).resolves.toBeUndefined();
    }
  });

  it("refuses to overwrite an unclaimed legacy export directory", async () => {
    const { store } = createStore();
    const target = session("legacy-collision");
    const sessionDir = store.sessionDir(target);
    fs.mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = path.join(sessionDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, '{"text":"legacy line"}\n');

    await expect(store.writeSession(target)).rejects.toThrow("run openclaw doctor --fix");
    expect(fs.readFileSync(transcriptPath, "utf8")).toContain("legacy line");
  });

  it.runIf(process.platform !== "win32")(
    "checks the shipped slug path before inserting a portable encoded session",
    async () => {
      const { stateDir, store } = createStore();
      const target = session("trailing-dot.");
      const legacyDir = path.join(stateDir, "transcripts", "2026-07-01", "trailing-dot.");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "transcript.jsonl"), "legacy\n");

      await expect(store.writeSession(target)).rejects.toThrow("run openclaw doctor --fix");
      await expect(store.readSession(target.sessionId)).resolves.toBeUndefined();
    },
  );

  it("does not let a dot session mask the shipped dot-dot root layout", async () => {
    const { stateDir, store } = createStore();
    await store.writeSession(session("."));
    const transcriptRoot = path.join(stateDir, "transcripts");
    fs.mkdirSync(transcriptRoot, { recursive: true });
    fs.writeFileSync(path.join(transcriptRoot, "transcript.jsonl"), "legacy root transcript\n");

    await expect(store.writeSession(session(".."))).rejects.toThrow("run openclaw doctor --fix");
    await expect(store.readSession("..")).resolves.toBeUndefined();
  });

  it("does not let a modified export block canonical session updates", async () => {
    const { store } = createStore();
    const target = session("mutable-export");
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "canonical" });
    const artifacts = await store.materializeSessionArtifacts(target, "transcript");
    fs.appendFileSync(artifacts.transcriptPath, '{"text":"external edit"}\n');

    await expect(store.updateStopped(target.sessionId, "2026-07-01T11:00:00.000Z")).resolves.toBe(
      undefined,
    );
    await expect(store.readSession(target.sessionId)).resolves.toMatchObject({
      stoppedAt: "2026-07-01T11:00:00.000Z",
    });
    const summary = summarizeTranscripts({ session: target, utterances: [{ text: "canonical" }] });
    await expect(store.writeSummary(summary, target)).resolves.toBe(
      path.join(store.sessionDir(target), "summary.md"),
    );
    await expect(store.readSummary(target)).resolves.toMatchObject({
      summary: { sessionId: target.sessionId },
    });
    await expect(store.materializeSessionArtifacts(target, "transcript")).rejects.toThrow(
      "run openclaw doctor --fix",
    );
  });

  it("resolves descriptor exports through canonical SQLite identity", async () => {
    const { store } = createStore();
    const target = { ...session("canonical-export"), title: "Canonical title" };
    await store.writeSession(target);

    const artifacts = await store.materializeSessionArtifacts(
      { ...target, title: "Stale title" },
      "metadata",
    );

    expect(fs.readFileSync(artifacts.metadataPath, "utf8")).toContain("Canonical title");
    await expect(
      store.materializeSessionArtifacts(session("phantom-export"), "metadata"),
    ).rejects.toThrow("transcripts session not found");
    expect(fs.existsSync(store.sessionDir(session("phantom-export")))).toBe(false);
  });

  it("stores summaries in SQLite and materializes explicit artifacts", async () => {
    const { stateDir, store } = createStore();
    const target = {
      ...session("ansi-\u001b[31mprovider\u001b[0m", "2026-05-22T10:00:00.000Z"),
      title: "ANSI import",
    };
    await store.writeSession(target);
    const utterance = {
      text: "We decided to ship the CLI.",
      speaker: { label: "Sam" },
    };
    const utterances = [utterance];
    await store.appendUtteranceForSession(target, utterance);
    const summary = summarizeTranscripts({ session: target, utterances });

    const markdownPath = await store.writeSummary(summary, target);
    const artifacts = await store.materializeSessionArtifacts(target, "all");

    expect(markdownPath).toBe(path.join(store.sessionDir(target), "summary.md"));
    expect(JSON.parse(fs.readFileSync(artifacts.summaryJsonPath, "utf8"))).toMatchObject({
      sessionId: target.sessionId,
    });
    expect(fs.readFileSync(artifacts.transcriptPath, "utf8")).toContain(
      '"text":"We decided to ship the CLI."',
    );
    closeOpenClawStateDatabaseForTest();
    const reopened = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await expect(reopened.readSummary(target)).resolves.toMatchObject({
      summary: { sessionId: target.sessionId },
    });
  });

  it("removes stale summary exports when canonical state has no summary", async () => {
    const { stateDir, store } = createStore();
    const target = session("no-summary");
    await store.writeSession(target);
    await store.writeSummary(
      summarizeTranscripts({ session: target, utterances: [{ text: "stale" }] }),
      target,
    );
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } })
      .db.prepare("DELETE FROM meeting_transcript_summaries WHERE session_id = ?")
      .run(target.sessionId);

    const artifacts = await store.materializeSessionArtifacts(target, "summary");

    expect(artifacts.hasSummary).toBe(false);
    expect(fs.existsSync(artifacts.summaryJsonPath)).toBe(false);
    expect(fs.existsSync(artifacts.summaryPath)).toBe(false);
  });

  it("repairs an interrupted manifest update and serializes concurrent exports", async () => {
    const { stateDir, store } = createStore();
    const target = session("recover-export");
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "recover me" });
    await store.writeSummary(
      summarizeTranscripts({ session: target, utterances: [{ text: "recover me" }] }),
      target,
    );
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } })
      .db.prepare(
        "UPDATE meeting_transcript_sessions SET export_manifest_json = '{}' WHERE session_id = ?",
      )
      .run(target.sessionId);

    await expect(
      Promise.all([
        store.materializeSessionArtifacts(target, "summary"),
        store.materializeSessionArtifacts(target, "transcript"),
      ]),
    ).resolves.toHaveLength(2);

    const manifest = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    })
      .db.prepare(
        "SELECT export_manifest_json FROM meeting_transcript_sessions WHERE session_id = ?",
      )
      .get(target.sessionId) as { export_manifest_json: string };
    expect(JSON.parse(manifest.export_manifest_json)).toMatchObject({
      "metadata.json": expect.any(String),
      "summary.md": expect.any(String),
      "transcript.jsonl": expect.any(String),
    });
  });
});
