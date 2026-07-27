import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

const { uuidQueue } = vi.hoisted(() => ({ uuidQueue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () =>
      (uuidQueue.shift() ??
        actual.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`,
  };
});

const { SessionManager } = await import("./session-manager.js");

function writeV1File(dir: string): string {
  const file = join(dir, "2026-01-01T00-00-00-000Z_sess-v1.jsonl");
  const header = {
    type: "session",
    version: 1,
    id: "v1-header-id",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/cwd",
  };
  const first = {
    type: "message",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "first" },
  };
  const second = {
    type: "message",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "assistant", content: "second" },
  };
  writeFileSync(file, [header, first, second].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("v1 session migration id assignment", () => {
  it("keeps migrated entry ids unique even when the id generator first collides", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-v1mig-"));
    const file = writeV1File(dir);

    uuidQueue.length = 0;
    uuidQueue.push(
      "deadbeef-0000-4000-8000-000000000000",
      "deadbeef-0000-4000-8000-000000000000",
      "cafef00d-0000-4000-8000-000000000000",
    );

    const sm = SessionManager.open(file, dir);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => ({
        id: (e as { id: string }).id,
        parentId: (e as { parentId: string | null }).parentId,
      }));

    expect(messages).toHaveLength(2);
    const ids = messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(expectDefined(messages[1], "messages[1] test invariant").parentId).toBe(
      expectDefined(messages[0], "messages[0] test invariant").id,
    );
    expect(expectDefined(messages[1], "messages[1] test invariant").parentId).not.toBe(
      expectDefined(messages[1], "messages[1] test invariant").id,
    );
  });

  it("preserves compaction indexes across opaque rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-v1mig-compaction-"));
    const file = join(dir, "session.jsonl");
    const keptMessage = {
      type: "message",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "kept" },
    };
    writeFileSync(
      file,
      [
        {
          type: "session",
          version: 1,
          id: "v1-header-id",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/tmp/cwd",
        },
        {
          type: "message",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "prelude" },
        },
        null,
        keptMessage,
        {
          type: "compaction",
          timestamp: "2026-01-01T00:00:03.000Z",
          summary: "summary",
          firstKeptEntryIndex: 3,
          tokensBefore: 200,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const sm = SessionManager.open(file, dir);
    const kept = sm
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "kept",
      );
    const compaction = sm.getEntries().find((entry) => entry.type === "compaction");

    expect(kept).toBeDefined();
    expect(compaction).toMatchObject({ firstKeptEntryId: kept?.id });
    expect(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toContain(null);
  });
});
