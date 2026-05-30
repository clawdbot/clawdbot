import { describe, expect, it } from "vitest";
import { ok, type FileSystem } from "../types.js";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.js";

type JsonlStorageFs = Pick<
  FileSystem,
  "readTextFile" | "readTextLines" | "writeFile" | "appendFile"
>;

function createReadOnlyFs(content: string): JsonlStorageFs {
  return {
    readTextFile: async () => ok(content),
    readTextLines: async (_path, options) => ok(content.split("\n").slice(0, options?.maxLines)),
    writeFile: async () => ok(undefined),
    appendFile: async () => ok(undefined),
  };
}

describe("JsonlSessionStorage timestamps", () => {
  it("rejects invalid session header timestamps", async () => {
    const fs = createReadOnlyFs(
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "not-a-date",
        cwd: "/repo",
      })}\n`,
    );

    await expect(loadJsonlSessionMetadata(fs, "/sessions/invalid.jsonl")).rejects.toThrow(
      "session header has invalid timestamp",
    );
  });

  it("rejects invalid entry timestamps", async () => {
    const fs = createReadOnlyFs(
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/repo",
      })}\n${JSON.stringify({
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: "not-a-date",
        customType: "note",
      })}\n`,
    );

    await expect(JsonlSessionStorage.open(fs, "/sessions/invalid-entry.jsonl")).rejects.toThrow(
      "line 2 has invalid timestamp",
    );
  });
});
