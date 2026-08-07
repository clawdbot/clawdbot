import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  foreignSessionIngestionSource,
  scanSessionIngestionSource,
  sessionIngestionSourceFromCorpus,
} from "./session-ingestion.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session ingestion", () => {
  it("preserves file-backed scope identity when a session id ends in .jsonl", () => {
    const source = sessionIngestionSourceFromCorpus({
      agentId: "main",
      artifactKind: "active-session",
      sessionFile: path.join(os.tmpdir(), "foo.jsonl.jsonl"),
      sessionId: "foo.jsonl",
      sessionKind: "interactive",
    });

    expect(source?.scope).toBe("main:foo.jsonl");
  });

  it("filters assistant process chatter while preserving durable lines and scan progress", async () => {
    const dir = tempDirs.make("openclaw-session-ingestion-");
    const archiveFile = path.join(dir, "archive.jsonl");
    const messages = [
      { role: "assistant", content: "Need commit PR.", timestamp: "2026-04-05T18:00:00.000Z" },
      { role: "assistant", content: "Now inspect.", timestamp: "2026-04-05T18:01:00.000Z" },
      {
        role: "assistant",
        content: "The migration is complete and all focused tests passed.",
        timestamp: "2026-04-05T18:02:00.000Z",
      },
      {
        role: "user",
        content: "Need commit PR before the release.",
        timestamp: "2026-04-05T18:03:00.000Z",
      },
    ];
    await fs.writeFile(
      archiveFile,
      `${messages
        .map((message, index) =>
          JSON.stringify({
            type: "message",
            id: `message-${index}`,
            timestamp: message.timestamp,
            message,
          }),
        )
        .join("\n")}\n`,
    );

    const result = await scanSessionIngestionSource({
      source: foreignSessionIngestionSource("main", archiveFile),
      seenMessages: {},
      verifyContent: true,
      classifyDay: () => "include",
    });

    expect(result.candidates.map((candidate) => candidate.snippet)).toEqual([
      "Assistant: The migration is complete and all focused tests passed.",
      "User: Need commit PR before the release.",
    ]);
    expect(result.fileState?.lastContentLine).toBe(4);
    expect(result.scannedEndIndex).toBe(4);
  });

  it("verifies backfill content despite an unchanged size and mtime", async () => {
    const dir = tempDirs.make("openclaw-session-ingestion-");
    const archiveFile = path.join(dir, "archive.jsonl");
    const record = (content: string) =>
      `${JSON.stringify({
        type: "message",
        id: "message-1",
        timestamp: "2026-04-05T18:00:00.000Z",
        message: {
          role: "user",
          content,
          timestamp: "2026-04-05T18:00:00.000Z",
        },
      })}\n`;
    const firstRaw = record("Alpha durable note.");
    const secondRaw = record("Bravo durable note.");
    expect(Buffer.byteLength(secondRaw)).toBe(Buffer.byteLength(firstRaw));
    const fixedTime = new Date("2026-04-06T00:00:00.000Z");
    await fs.writeFile(archiveFile, firstRaw);
    await fs.utimes(archiveFile, fixedTime, fixedTime);
    const source = foreignSessionIngestionSource("main", archiveFile);
    const first = await scanSessionIngestionSource({
      source,
      seenMessages: {},
      verifyContent: true,
      classifyDay: () => "include",
    });
    if (!first.fileState) {
      throw new Error("expected initial backfill checkpoint");
    }

    await fs.writeFile(archiveFile, secondRaw);
    await fs.utimes(archiveFile, fixedTime, fixedTime);
    const second = await scanSessionIngestionSource({
      source,
      previous: first.fileState,
      seenMessages: {},
      verifyContent: true,
      classifyDay: () => "include",
    });

    expect(second.candidates.map((candidate) => candidate.snippet)).toEqual([
      "User: Bravo durable note.",
    ]);
  });
});
