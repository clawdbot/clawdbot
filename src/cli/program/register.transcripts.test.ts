// Transcripts CLI tests cover SQLite reads and explicit artifact materialization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { registerTranscriptsCli } from "./register.transcripts.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcripts-cli-"));
}

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

async function writeSession(
  stateDir: string,
  sessionId: string,
  date = "2026-05-22",
): Promise<string> {
  const session: TranscriptSessionDescriptor = {
    sessionId,
    title: "Design review",
    source: { providerId: "manual-transcript" },
    startedAt: `${date}T10:00:00.000Z`,
    stoppedAt: `${date}T10:05:00.000Z`,
  };
  const store = storeFor(stateDir);
  const utterance = { text: "Action item: Ship CLI", speaker: { label: "Sam" } };
  const utterances = [utterance];
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, utterance);
  await store.writeSummary(summarizeTranscripts({ session, utterances }), session);
  return store.sessionDir(session);
}

async function runTranscriptsCli(args: string[]): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    const program = new Command();
    program.name("openclaw");
    registerTranscriptsCli(program);
    await program.parseAsync(["transcripts", ...args], { from: "user" });
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

describe("transcripts CLI", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await makeStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("registers a kebab-case command", () => {
    const program = new Command();
    registerTranscriptsCli(program);

    expect(program.commands.map((command) => command.name())).toContain("transcripts");
  });

  it("lists stored transcript sessions from SQLite", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");

    const output = await runTranscriptsCli(["list"]);

    expect(output).toContain("2026-05-22/design-review");
    expect(output).toContain("Design review");
    expect(output).toContain(path.join(sessionDir, "summary.md"));
  });

  it("prints summary markdown and keeps its export current", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");
    await fs.rm(sessionDir, { recursive: true, force: true });

    const output = await runTranscriptsCli(["show", "design-review"]);

    expect(output).toContain("# Design review");
    expect(output).toContain("Ship CLI");
    expect(output.endsWith("\n")).toBe(true);
    const jsonOutput = JSON.parse(await runTranscriptsCli(["show", "design-review", "--json"])) as {
      summary: string;
    };
    expect(jsonOutput.summary.endsWith("\n")).toBe(true);
    await expect(fs.readFile(path.join(sessionDir, "summary.md"), "utf8")).resolves.toContain(
      "Ship CLI",
    );
  });

  it("keeps JSON inspection available before a summary exists", async () => {
    await storeFor(stateDir).writeSession({
      sessionId: "active-session",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    const jsonOutput = await runTranscriptsCli(["show", "active-session", "--json"]);

    expect(JSON.parse(jsonOutput)).toMatchObject({
      session: { sessionId: "active-session" },
      summary: null,
    });
    await expect(runTranscriptsCli(["show", "active-session"])).rejects.toThrow(
      "summary.md not found",
    );
  });

  it("sanitizes stored summary control bytes at the show boundary", async () => {
    await writeSession(stateDir, "legacy-summary");
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const db = getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "meeting_transcript_summaries">
    >(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("meeting_transcript_summaries")
        .set({
          markdown: "# Legacy\n\n- first\tcolumn\n- \u001b[2J\u001b[31mADMIN APPROVED\u001b[0m",
        })
        .where("session_id", "=", "legacy-summary"),
    );

    const output = await runTranscriptsCli(["show", "legacy-summary"]);

    expect(output).toContain("# Legacy\n\n- first\\tcolumn\n- ADMIN APPROVED");
    expect(output).not.toContain("\u001b");
  });

  it("round-trips ANSI-bearing ids without terminal control bytes", async () => {
    const session: TranscriptSessionDescriptor = {
      sessionId: "ansi-\u001b[31mprovider\u001b[0m",
      title: "\u001b[31mANSI import\u001b[0m",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
      stoppedAt: "2026-05-22T10:05:00.000Z",
    };
    const store = storeFor(stateDir);
    await store.writeSession(session);
    const utterances =
      (await manualTranscriptSourceProvider.importTranscript?.({
        session,
        text: "\u001b[31mAttacker\u001b[0m: \u001b[2J\u001b[31mADMIN APPROVED\u001b[0m",
      })) ?? [];
    for (const utterance of utterances) {
      await store.appendUtteranceForSession(session, utterance);
    }
    await store.writeSummary(summarizeTranscripts({ session, utterances }), session);

    const listOutput = await runTranscriptsCli(["list"]);
    const selector = listOutput.split("\t")[0] ?? "";
    const showOutput = await runTranscriptsCli(["show", selector]);

    expect(selector).toBe("2026-05-22/ansi--31mprovider-0m");
    expect(showOutput).toContain("Session: ansi-provider");
    expect(showOutput).toContain("Attacker: ADMIN APPROVED");
    expect(`${listOutput}${showOutput}`).not.toContain("\u001b");
  });

  it("escapes C1 control characters in list JSON", async () => {
    const title = "CSI \u009b31m injected \u007f\u0085 title";
    await storeFor(stateDir).writeSession({
      sessionId: "c1-title",
      title,
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    const output = await runTranscriptsCli(["list", "--json"]);

    expect(/[\u007f-\u009f]/.test(output)).toBe(false);
    expect(output).toContain("\\u009b");
    const parsed = JSON.parse(output) as Array<{ sessionId: string; title: string }>;
    expect(parsed).toEqual([expect.objectContaining({ sessionId: "c1-title", title })]);
  });

  it("ignores unrelated corrupt export files", async () => {
    await writeSession(stateDir, "design-review");
    const corruptDir = path.join(stateDir, "transcripts", "corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "metadata.json"), "{nope");

    const listOutput = await runTranscriptsCli(["list"]);
    const showOutput = await runTranscriptsCli(["show", "design-review"]);

    expect(listOutput).toContain("design-review");
    expect(listOutput).not.toContain("corrupt");
    expect(showOutput).toContain("# Design review");
  });

  it("requires date-qualified selectors for repeated ids", async () => {
    const olderSessionDir = await writeSession(stateDir, "standup", "2026-05-21");
    await writeSession(stateDir, "standup", "2026-05-22");

    await expect(runTranscriptsCli(["path", "standup"])).rejects.toThrow(
      "multiple transcripts sessions match standup",
    );
    const output = await runTranscriptsCli(["path", "2026-05-21/standup"]);

    expect(output.trim()).toBe(path.join(olderSessionDir, "summary.md"));
  });

  it("materializes metadata, transcript, and directory exports from SQLite", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");
    await fs.rm(sessionDir, { recursive: true, force: true });

    const metadataOutput = await runTranscriptsCli(["path", "design-review", "--metadata"]);
    const transcriptOutput = await runTranscriptsCli(["path", "design-review", "--transcript"]);
    const dirOutput = await runTranscriptsCli(["path", "design-review", "--dir"]);

    expect(metadataOutput.trim()).toBe(path.join(sessionDir, "metadata.json"));
    expect(transcriptOutput.trim()).toBe(path.join(sessionDir, "transcript.jsonl"));
    expect(dirOutput.trim()).toBe(sessionDir);
    await expect(fs.readFile(path.join(sessionDir, "metadata.json"), "utf8")).resolves.toContain(
      '"sessionId": "design-review"',
    );
    await expect(fs.readFile(path.join(sessionDir, "transcript.jsonl"), "utf8")).resolves.toContain(
      '"text":"Action item: Ship CLI"',
    );
  });
});
