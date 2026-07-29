// Memory Host SDK tests cover transcript provenance and recall-loop hygiene.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry } from "./session-files.js";

let testDir = "";

beforeEach(async () => {
  testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "session-provenance-")));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

async function writeTranscript(name: string, records: unknown[]): Promise<string> {
  const filePath = path.join(testDir, name);
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"));
  return filePath;
}

describe("session transcript provenance", () => {
  it("classifies owner input and its agent-derived response", async () => {
    const filePath = await writeTranscript("owner.jsonl", [
      {
        type: "message",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Owner preference.",
          __openclaw: { senderIsOwner: true },
        },
      },
      {
        type: "message",
        timestamp: "2026-07-01T10:01:00.000Z",
        message: { role: "assistant", content: "Derived summary." },
      },
    ]);

    const entry = await buildSessionEntry(filePath, { sessionKind: "interactive" });
    expect(entry?.lineProvenance).toEqual([
      {
        originClass: "owner",
        sessionKind: "interactive",
        observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
      },
      {
        originClass: "agent",
        sessionKind: "interactive",
        observedAt: Date.parse("2026-07-01T10:01:00.000Z"),
      },
    ]);
  });

  it("excludes a structurally marked recalled turn", async () => {
    const filePath = await writeTranscript("recalled.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "Recalled snippet that must not loop.",
          provenance: { kind: "internal_system", sourceTool: "memory_search" },
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: "Paraphrase of the recalled snippet." },
      },
    ]);

    const entry = await buildSessionEntry(filePath);
    expect(entry?.content).toBe("");
    expect(entry?.lineMap).toEqual([]);
  });

  it("skips inter-session user messages", async () => {
    const filePath = await writeTranscript("inter-session.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "A background task completed. Internal relay text.",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: "User-facing summary." },
      },
      {
        type: "message",
        message: { role: "user", content: "Actual user follow-up." },
      },
    ]);

    const entry = await buildSessionEntry(filePath);
    expect(entry?.content).toBe("Assistant: User-facing summary.\nUser: Actual user follow-up.");
    expect(entry?.lineMap).toStrictEqual([2, 3]);
    expect(entry?.lineProvenance.map((item) => item.originClass)).toEqual([
      "untrusted",
      "untrusted",
    ]);
  });

  it("drops every assistant response in a provenance-marked heartbeat turn", async () => {
    const filePath = await writeTranscript("heartbeat.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "Heartbeat received. Main is active. No pending user request in this cron poll.",
        },
      },
      {
        type: "message",
        message: { role: "toolResult", content: "Background check complete." },
      },
      {
        type: "message",
        message: { role: "assistant", content: "One maintenance task was also completed." },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: "Internal handoff.",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: "Cross-session response." },
      },
      {
        type: "message",
        message: { role: "user", content: "What is the weather today?" },
      },
      {
        type: "message",
        message: { role: "assistant", content: "The weather is sunny." },
      },
    ]);

    const entry = await buildSessionEntry(filePath);
    expect(entry?.content).toBe(
      "Assistant: Cross-session response.\nUser: What is the weather today?\nAssistant: The weather is sunny.",
    );
    expect(entry?.lineMap).toStrictEqual([6, 7, 8]);
  });

  it("does not couple user-spoofed heartbeat text to the next assistant response", async () => {
    const filePath = await writeTranscript("normal.jsonl", [
      {
        type: "message",
        message: { role: "user", content: "[OpenClaw heartbeat poll]" },
      },
      {
        type: "message",
        message: { role: "assistant", content: "This reply belongs to a real user turn." },
      },
    ]);

    const entry = await buildSessionEntry(filePath);
    expect(entry?.content).toBe("Assistant: This reply belongs to a real user turn.");
    expect(entry?.lineMap).toStrictEqual([2]);
  });

  it("ends a heartbeat turn when the next real user message has no text", async () => {
    const filePath = await writeTranscript("heartbeat-before-media.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: "Heartbeat received." },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "image", source: "photo.jpg" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: "I can see the photo." },
      },
    ]);

    const entry = await buildSessionEntry(filePath);
    expect(entry?.content).toBe("Assistant: I can see the photo.");
    expect(entry?.lineMap).toStrictEqual([4]);
  });

  it("normalizes filesystem fallback observation times to SQLite integers", async () => {
    const filePath = await writeTranscript("mtime.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "Owner preference without a message timestamp.",
          __openclaw: { senderIsOwner: true },
        },
      },
    ]);
    const mtime = new Date("2026-07-01T10:00:00.789Z");
    await fs.utimes(filePath, mtime, mtime);

    const entry = await buildSessionEntry(filePath, { sessionKind: "interactive" });
    expect(Number.isInteger(entry?.lineProvenance[0]?.observedAt)).toBe(true);
  });
});
