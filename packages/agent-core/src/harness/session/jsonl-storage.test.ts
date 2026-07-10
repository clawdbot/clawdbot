// Agent Core tests cover jsonl storage behavior.
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.js";
import { ok, type FileSystem } from "../types.js";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.js";
import { Session } from "./session.js";

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

  it("reports physical entry line numbers when blank JSONL rows are skipped", async () => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/repo",
    });
    const entry = JSON.stringify({
      type: "custom",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "note",
    });
    const invalidContent = [header, "\t\r", "", entry, "  ", "not-json", ""].join("\n");
    const validContent = [header, "\t\r", "", entry, "  ", ""].join("\n");
    const rootEnv = new NodeExecutionEnv({ cwd: process.cwd() });
    const created = await rootEnv.createTempDir("agent-core-jsonl-");
    if (!created.ok) {
      throw created.error;
    }
    const fs = new NodeExecutionEnv({ cwd: created.value });

    try {
      const invalidWrite = await fs.writeFile("invalid-entry.jsonl", invalidContent);
      if (!invalidWrite.ok) {
        throw invalidWrite.error;
      }
      await expect(JsonlSessionStorage.open(fs, "invalid-entry.jsonl")).rejects.toMatchObject({
        name: "SessionError",
        code: "invalid_entry",
        message: "Invalid JSONL session file invalid-entry.jsonl: line 6 is not valid JSON",
      });

      const validWrite = await fs.writeFile("valid.jsonl", validContent);
      if (!validWrite.ok) {
        throw validWrite.error;
      }
      const storage = await JsonlSessionStorage.open(fs, "valid.jsonl");
      expect((await storage.getEntries()).map((storedEntry) => storedEntry.id)).toEqual([
        "entry-1",
      ]);
    } finally {
      const removed = await rootEnv.remove(created.value, { recursive: true, force: true });
      expect(removed.ok).toBe(true);
    }
  });

  it("uses a leaf control's opaque append parent for the next entry", async () => {
    let content = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/repo",
      },
      {
        type: "custom",
        id: "active-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        customType: "root",
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: null,
        timestamp: "2026-06-15T00:00:02.000Z",
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-root",
        appendParentId: "plugin-metadata",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    content += "\n";
    const fs: JsonlStorageFs = {
      ...createReadOnlyFs(content),
      readTextFile: async () => ok(content),
      appendFile: async (_path, appended) => {
        content += String(appended);
        return ok(undefined);
      },
    };
    const storage = await JsonlSessionStorage.open(fs, "/sessions/session.jsonl");
    const session = new Session(storage);

    expect(await session.getLeafId()).toBe("active-root");
    const entryId = await session.appendCustomEntry("continued");
    const entry = await session.getEntry(entryId);

    expect(entry).toMatchObject({ parentId: "plugin-metadata" });
    expect((await storage.getPathToRoot(entryId)).map((pathEntry) => pathEntry.id)).toEqual([
      "active-root",
      entryId,
    ]);
    expect(content.trim().split(/\r?\n/).at(-1)).toContain('"parentId":"plugin-metadata"');
  });

  it("keeps a terminal side append off the visible branch", async () => {
    let content = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/repo",
      },
      {
        type: "custom",
        id: "active-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        customType: "active",
      },
      {
        type: "custom",
        id: "side-one",
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:02.000Z",
        customType: "side",
      },
      {
        type: "leaf",
        id: "side-leaf",
        parentId: "side-one",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-root",
        appendParentId: "side-one",
        appendMode: "side",
      },
      {
        type: "custom",
        id: "side-two",
        parentId: "side-one",
        timestamp: "2026-06-15T00:00:04.000Z",
        customType: "side",
        appendMode: "side",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    content += "\n";
    const fs: JsonlStorageFs = {
      ...createReadOnlyFs(content),
      readTextFile: async () => ok(content),
      appendFile: async (_path, appended) => {
        content += String(appended);
        return ok(undefined);
      },
    };
    const storage = await JsonlSessionStorage.open(fs, "/sessions/session.jsonl");
    const session = new Session(storage);

    expect(await storage.getLeafId()).toBe("active-root");
    expect(await storage.getAppendParentId()).toBe("side-two");
    const entryId = await session.appendCustomEntry("continued");

    expect(await storage.getEntry(entryId)).toMatchObject({ parentId: "side-two" });
    expect((await storage.getPathToRoot(entryId)).map((entry) => entry.id)).toEqual([
      "active-root",
      entryId,
    ]);
  });

  it("does not let opaque rows replace the selected visible leaf", async () => {
    const content = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/repo",
      },
      {
        type: "custom",
        id: "active-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        customType: "active",
      },
      {
        type: "custom",
        id: "inactive-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:02.000Z",
        customType: "inactive",
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-root",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-root",
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "inactive-root",
        timestamp: "2026-06-15T00:00:04.000Z",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const storage = await JsonlSessionStorage.open(
      createReadOnlyFs(`${content}\n`),
      "/sessions/session.jsonl",
    );
    const session = new Session(storage);

    expect(await session.getLeafId()).toBe("active-root");
    expect((await session.getBranch()).map((entry) => entry.id)).toEqual(["active-root"]);
  });

  it("rejects a leaf control with a missing append parent", async () => {
    const content = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/repo",
      },
      {
        type: "custom",
        id: "active-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        customType: "active",
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:02.000Z",
        targetId: "active-root",
        appendParentId: "missing",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    await expect(
      JsonlSessionStorage.open(createReadOnlyFs(`${content}\n`), "/sessions/session.jsonl"),
    ).rejects.toThrow("Append parent missing not found");
  });
});
