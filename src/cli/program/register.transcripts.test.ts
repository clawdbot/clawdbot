// Register transcripts tests cover transcript command registration and file handling.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { registerTranscriptsCli } from "./register.transcripts.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcripts-cli-"));
}

async function writeSession(
  stateDir: string,
  sessionId: string,
  date = "2026-05-22",
): Promise<string> {
  const sessionDir = path.join(stateDir, "transcripts", date, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(
      {
        sessionId,
        title: "Design review",
        source: { providerId: "manual-transcript" },
        startedAt: `${date}T10:00:00.000Z`,
        stoppedAt: `${date}T10:05:00.000Z`,
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, "summary.md"),
    "# Design review\n\n## Action Items\n- Sam: Ship CLI\n",
  );
  return sessionDir;
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

  it("lists stored transcript sessions", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");

    const output = await runTranscriptsCli(["list"]);

    expect(output).toContain("2026-05-22/design-review");
    expect(output).toContain("Design review");
    expect(output).toContain(path.join(sessionDir, "summary.md"));
  });

  it("prints summary markdown for a session", async () => {
    await writeSession(stateDir, "design-review");

    const output = await runTranscriptsCli(["show", "design-review"]);

    expect(output).toContain("# Design review");
    expect(output).toContain("Ship CLI");
  });

  it("sanitizes summaries created before the upgrade at the show boundary", async () => {
    const sessionDir = await writeSession(stateDir, "legacy-summary");
    await fs.writeFile(
      path.join(sessionDir, "summary.md"),
      "# Legacy\n\n- first\tcolumn\n- \u001b[2J\u001b[31mADMIN APPROVED\u001b[0m\n",
    );

    const output = await runTranscriptsCli(["show", "legacy-summary"]);

    expect(output).toContain("# Legacy\n\n- first\\tcolumn\n- ADMIN APPROVED\n");
    expect(output).not.toContain("\u001b");
  });

  it("show prints imported summaries without terminal control bytes", async () => {
    const session: TranscriptSessionDescriptor = {
      sessionId: "ansi-\u001b[31mprovider\u001b[0m",
      title: "\u001b[31mANSI import\u001b[0m",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
      stoppedAt: "2026-05-22T10:05:00.000Z",
    };
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
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

    const output = await runTranscriptsCli(["show", session.sessionId]);
    const listOutput = await runTranscriptsCli(["list"]);

    expect(output).toContain("# ANSI import");
    expect(output).toContain("Session: ansi-provider");
    expect(output).toContain("Attacker: ADMIN APPROVED");
    expect(output).not.toContain("\u001b");
    expect(listOutput).toContain("2026-05-22/ansi--31mprovider-0m");
    expect(listOutput).toContain("ANSI import");
    expect(listOutput).not.toContain("\u001b");
  });

  it("list selectors for ANSI-bearing session ids round-trip through show and path", async () => {
    const session: TranscriptSessionDescriptor = {
      sessionId: "ansi-\u001b[31mprovider\u001b[0m",
      title: "ANSI import",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
      stoppedAt: "2026-05-22T10:05:00.000Z",
    };
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
    await store.writeSession(session);
    const utterances =
      (await manualTranscriptSourceProvider.importTranscript?.({
        session,
        text: "Sam: We decided to ship the CLI.",
      })) ?? [];
    await store.writeSummary(summarizeTranscripts({ session, utterances }), session);

    const listOutput = await runTranscriptsCli(["list"]);
    const selector = listOutput.split("\t")[0] ?? "";
    expect(selector).toBe("2026-05-22/ansi--31mprovider-0m");

    const showOutput = await runTranscriptsCli(["show", selector]);
    const pathOutput = await runTranscriptsCli(["path", selector]);

    expect(showOutput).toContain("Session: ansi-provider");
    expect(showOutput).toContain("We decided to ship the CLI.");
    expect(pathOutput.trim()).toBe(path.join(store.sessionDir(session), "summary.md"));
  });

  it("list --json escapes C1 control characters while JSON.parse round-trips raw values", async () => {
    const title = "CSI \u009b31m injected \u007f\u0085 title";
    const sessionDir = path.join(stateDir, "transcripts", "2026-05-22", "c1-title");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "metadata.json"),
      JSON.stringify({
        sessionId: "c1-title",
        title,
        source: { providerId: "manual-transcript" },
        startedAt: "2026-05-22T10:00:00.000Z",
        stoppedAt: "2026-05-22T10:05:00.000Z",
      }),
    );

    const output = await runTranscriptsCli(["list", "--json"]);

    const bytes = Buffer.from(output, "utf8");
    expect(bytes.includes(Buffer.from([0xc2, 0x9b]))).toBe(false);
    expect(bytes.includes(0x7f)).toBe(false);
    expect(/[\u007f-\u009f]/.test(output)).toBe(false);
    expect(output).toContain("\\u009b");
    const parsed = JSON.parse(output) as Array<{ sessionId: string; title: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sessionId).toBe("c1-title");
    expect(parsed[0]?.title).toBe(title);
  });

  it("ignores unrelated corrupt metadata while reading a valid session", async () => {
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

  it("requires date-qualified selectors for repeated human session ids", async () => {
    const olderSessionDir = await writeSession(stateDir, "standup", "2026-05-21");
    await writeSession(stateDir, "standup", "2026-05-22");

    await expect(runTranscriptsCli(["path", "standup"])).rejects.toThrow(
      "multiple transcripts sessions match standup",
    );
    const output = await runTranscriptsCli(["path", "2026-05-21/standup"]);

    expect(output.trim()).toBe(path.join(olderSessionDir, "summary.md"));
  });

  it("prints the summary path by default", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");

    const output = await runTranscriptsCli(["path", "design-review"]);

    expect(output.trim()).toBe(path.join(sessionDir, "summary.md"));
  });
});
