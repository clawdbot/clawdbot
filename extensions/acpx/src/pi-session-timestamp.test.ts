import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalPiSessionPage, readLocalPiTranscriptPage } from "./pi-session-catalog.js";
import { createPiStoreFixture } from "./pi-session-catalog.test-support.js";

const temporaryDirectories: string[] = [];
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Pi session timestamp contract", () => {
  it("preserves date parsing for numeric-looking timestamp strings", async () => {
    const directory = await createPiStoreFixture(temporaryDirectories);
    const entries = [
      {
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: "2026",
        cwd: "/workspace",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026",
        message: { role: "user", content: "hello", timestamp: "0" },
      },
    ];
    await fs.writeFile(
      path.join(directory, "session.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const listed = await listLocalPiSessionPage({ limit: 20 });
    expect(listed.sessions[0]?.createdAt).toBe(Date.parse("2026"));
    expect(listed.sessions[0]?.createdAt).not.toBe(2_026);

    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
    expect(transcript.items[0]?.timestamp).toBe(new Date(Date.parse("0")).toISOString());
    expect(transcript.items[0]?.timestamp).not.toBe(new Date(0).toISOString());
  });
});
