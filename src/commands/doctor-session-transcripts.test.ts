// Doctor session transcript tests cover transcript inspection and repair guidance.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";

const note = vi.hoisted(() => vi.fn());
const runDoctorSessionSqlite = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite,
}));

import {
  detectSessionTranscriptHealthIssues,
  noteSessionTranscriptHealth,
  repairBrokenSessionTranscriptFile,
  sessionTranscriptIssueToHealthFinding,
  sessionTranscriptIssueToRepairEffect,
} from "./doctor-session-transcripts.js";

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line) {
      count += 1;
    }
  }
  return count;
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("doctor session transcript repair", () => {
  let root: string;

  beforeEach(async () => {
    note.mockClear();
    runDoctorSessionSqlite.mockReset();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return filePath;
  }

  it("rewrites affected prompt-rewrite branches to the active branch", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content: [
            "visible ask",
            "",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "secret",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "plain-assistant",
        parentId: "plain-user",
        message: { role: "assistant", content: "answer" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.originalEntries).toBe(6);
    expect(result.activeEntries).toBe(3);
    if (result.backupPath === undefined) {
      throw new Error("expected transcript backup path");
    }
    await expect(fs.access(result.backupPath)).resolves.toBeUndefined();
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(
      lines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type !== "session")
        .map((entry) => entry.id),
    ).toEqual(["parent", "plain-user", "plain-assistant"]);
  });

  it("reports affected transcripts without rewriting outside repair mode", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        parentId: null,
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: null,
        message: { role: "user", content: "visible ask" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: false, sessionDirs: [sessionsDir] });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = requireFirstMockCall(note, "doctor note") as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("legacy state");
    expect(message).toContain('Run "openclaw doctor --fix"');
    expect(countNonEmptyLines(await fs.readFile(filePath, "utf-8"))).toBe(3);
  });

  it("maps affected transcripts to structured findings and dry-run effects", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    const [issue] = await detectSessionTranscriptHealthIssues({ sessionDirs: [sessionsDir] });

    if (!issue) {
      throw new Error("expected session transcript health issue");
    }
    expect(issue?.filePath).toBe(filePath);
    expect(sessionTranscriptIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/session-transcripts",
      severity: "info",
      path: filePath,
      fixHint: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(sessionTranscriptIssueToRepairEffect(issue)).toEqual({
      kind: "file",
      action: "would-rewrite-session-transcript",
      target: filePath,
      dryRunSafe: false,
    });
    expect(await fs.readFile(filePath, "utf-8")).toContain("openai-codex");
  });

  it("runs session SQLite import through the public doctor repair path", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedTranscriptEvents: 2,
        issues: 0,
        legacyEntries: 1,
        sqliteEntries: 1,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };

    await noteSessionTranscriptHealth({
      env,
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      env,
      mode: "import",
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Legacy entries: 1"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Archived 2 legacy transcript artifact(s)."),
      "Session SQLite",
    );
  });

  it("repairs supported current-version linear transcripts", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-linear", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        timestamp: "2026-06-15T00:00:01Z",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        timestamp: "2026-06-15T00:00:02Z",
        message: { role: "user", content: "visible ask" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.map((entry) => entry.id)).toEqual(["session-linear", "plain-user"]);
  });

  it("repairs the branch selected by a terminal leaf control", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "message",
        id: "side-delivery",
        parentId: "active-assistant",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "runtime-assistant",
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-delivery",
        targetId: "active-assistant",
        appendParentId: "plugin-metadata",
      },
      {
        type: "metadata",
        id: "post-leaf-metadata",
        parentId: "plugin-metadata",
        payload: { phase: "after-leaf" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const repaired = await fs.readFile(filePath, "utf-8");
    expect(repaired).toContain("answer");
    expect(repaired).toContain("plugin-metadata");
    expect(repaired).toContain("post-leaf-metadata");
    expect(repaired).not.toContain("side delivery");
    expect(repaired).not.toContain("secret");
    const repairedRecords = repaired
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(repairedRecords.find((entry) => entry.id === "plugin-metadata")).toMatchObject({
      parentId: "active-assistant",
    });
    const reopened = SessionManager.open(filePath, path.dirname(filePath));
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "post-leaf-metadata" });
  });

  it("preserves parentless visible history and a disjoint append cursor", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-disjoint", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "visible-parent",
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "active-user",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "visible-parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "metadata",
        id: "append-root",
        parentId: null,
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "append-root",
        targetId: "active-assistant",
        appendParentId: "append-root",
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const repaired = await fs.readFile(filePath, "utf-8");
    expect(repaired).toContain("previous");
    expect(repaired).toContain("answer");
    expect(repaired).toContain('"id":"append-root"');
    expect(repaired).not.toContain("stale");
    const reopened = SessionManager.open(filePath, path.dirname(filePath));
    expect(reopened.buildSessionContext().messages).toHaveLength(3);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "append-root" });
  });

  it("preserves an explicit root append cursor while repairing the visible branch", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-root", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "leaf",
        id: "root-append-control",
        parentId: "runtime-assistant",
        targetId: "active-assistant",
        appendParentId: null,
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const reopened = SessionManager.open(filePath, path.dirname(filePath));
    expect(reopened.buildSessionContext().messages).toHaveLength(3);
    reopened.appendMessage({ role: "user", content: "new root", timestamp: Date.now() });
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.at(-2)).toMatchObject({
      type: "leaf",
      targetId: "active-assistant",
      appendParentId: null,
    });
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: null });
  });

  it("rewrites legacy OpenAI Codex transcript metadata only during doctor repair", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    const preview = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: false });

    expect(preview.broken).toBe(true);
    expect(preview.repaired).toBe(false);
    expect(preview.legacyOpenAICodexEntries).toBe(1);
    expect(await fs.readFile(filePath, "utf-8")).toContain("openai-codex");

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.legacyOpenAICodexEntries).toBe(1);
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    const assistant = JSON.parse(expectDefined(lines[1], "lines[1] test invariant"));
    expect(assistant.message.provider).toBe("openai");
    expect(assistant.message.api).toBe("openai-chatgpt-responses");
  });

  it("ignores ordinary branch history without internal runtime context", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "branch-a",
        parentId: null,
        message: { role: "user", content: "draft A" },
      },
      {
        type: "message",
        id: "branch-b",
        parentId: null,
        message: { role: "user", content: "draft B" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(false);
    expect(countNonEmptyLines(await fs.readFile(filePath, "utf-8"))).toBe(3);
  });
});
