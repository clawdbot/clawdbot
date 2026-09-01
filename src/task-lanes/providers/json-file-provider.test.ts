// JSON-file task-lane provider: path safety, bounds, URL sanitization.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_LANE_MAX_FILE_BYTES } from "../types.js";
import { createJsonFileProvider, loadJsonFileProviderLanes } from "./json-file-provider.js";

const VALID_DOC = {
  schemaVersion: 1,
  lanes: [
    {
      id: "ingest",
      label: "Ingest queue",
      items: [
        {
          id: "item-1",
          title: "Normalize corpus",
          state: "running",
          startedAtMs: 1_700_000_000_000,
          artifactUrl: "https://example.com/a",
        },
      ],
    },
  ],
};

function readerReturning(value: unknown) {
  return async () => Buffer.from(JSON.stringify(value), "utf8");
}

describe("json-file task-lane provider", () => {
  it("loads a well-formed file", async () => {
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning(VALID_DOC),
      resolveRealpath: async (p) => p,
    });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.id).toBe("ingest");
    expect(lanes[0]?.items[0]?.artifactUrl).toBe("https://example.com/a");
  });

  it("returns no lanes for an empty lanes array", async () => {
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({ schemaVersion: 1, lanes: [] }),
      resolveRealpath: async (p) => p,
    });
    expect(lanes).toEqual([]);
  });

  it("throws when the resolved file escapes the root via traversal", async () => {
    await expect(
      loadJsonFileProviderLanes({
        rootDir: "/data/lanes",
        filePath: "../outside.json",
        reader: readerReturning(VALID_DOC),
        resolveRealpath: async (p) => p,
      }),
    ).rejects.toThrow(/escapes root/);
  });

  it("throws when a symlink resolves outside the root", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "task-lane-"));
    try {
      const root = path.join(tmp, "root");
      const outside = path.join(tmp, "outside.json");
      await fs.mkdir(root);
      await fs.writeFile(outside, JSON.stringify(VALID_DOC));
      await fs.symlink(outside, path.join(root, "link.json"));
      await expect(
        loadJsonFileProviderLanes({ rootDir: root, filePath: "link.json" }),
      ).rejects.toThrow(/escapes root/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws when the file exceeds the size cap", async () => {
    await expect(
      loadJsonFileProviderLanes({
        rootDir: "/data/lanes",
        filePath: "board.json",
        reader: async () => Buffer.alloc(TASK_LANE_MAX_FILE_BYTES + 1, 0x20),
        resolveRealpath: async (p) => p,
      }),
    ).rejects.toThrow(/too large/);
  });

  it("throws on invalid JSON", async () => {
    await expect(
      loadJsonFileProviderLanes({
        rootDir: "/data/lanes",
        filePath: "board.json",
        reader: async () => Buffer.from("{not json", "utf8"),
        resolveRealpath: async (p) => p,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws on a non-object root", async () => {
    await expect(
      loadJsonFileProviderLanes({
        rootDir: "/data/lanes",
        filePath: "board.json",
        reader: readerReturning([1, 2, 3]),
        resolveRealpath: async (p) => p,
      }),
    ).rejects.toThrow(/not an object/);
  });

  it("throws on an unsupported schemaVersion", async () => {
    await expect(
      loadJsonFileProviderLanes({
        rootDir: "/data/lanes",
        filePath: "board.json",
        reader: readerReturning({ ...VALID_DOC, schemaVersion: 2 }),
        resolveRealpath: async (p) => p,
      }),
    ).rejects.toThrow(/schemaVersion/);
  });

  it("truncates lanes beyond the lane cap", async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `lane-${index}`,
      label: `Lane ${index}`,
      items: [],
    }));
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({ schemaVersion: 1, lanes: many }),
      resolveRealpath: async (p) => p,
    });
    expect(lanes).toHaveLength(20);
  });

  it("truncates items beyond the per-lane cap", async () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `item-${index}`,
      title: `Item ${index}`,
      state: "pending",
    }));
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({
        schemaVersion: 1,
        lanes: [{ id: "big", label: "Big", items }],
      }),
      resolveRealpath: async (p) => p,
    });
    expect(lanes[0]?.items).toHaveLength(200);
  });

  it("drops artifactUrl values outside the http(s) allowlist", async () => {
    const base = {
      id: "item",
      title: "t",
      state: "pending",
    };
    const rejected: Array<Record<string, unknown>> = [
      { ...base, id: "a", artifactUrl: "file:///etc/passwd" },
      { ...base, id: "b", artifactUrl: "javascript:alert(1)" },
      { ...base, id: "c", artifactUrl: "https://example.com/../secret" },
      { ...base, id: "d", artifactUrl: "https://exa mple.com/x" },
      { ...base, id: "e", artifactUrl: "https://example.com/\u0000x" },
      { ...base, id: "f", artifactUrl: "not a url" },
    ];
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({
        schemaVersion: 1,
        lanes: [{ id: "urls", label: "URLs", items: rejected }],
      }),
      resolveRealpath: async (p) => p,
    });
    expect(lanes[0]?.items).toHaveLength(6);
    for (const item of lanes[0]?.items ?? []) {
      expect(item.artifactUrl).toBeUndefined();
    }
  });

  it("truncates over-long titles with an ellipsis", async () => {
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({
        schemaVersion: 1,
        lanes: [
          {
            id: "long",
            label: "x".repeat(500),
            items: [{ id: "i", title: "y".repeat(500), state: "pending" }],
          },
        ],
      }),
      resolveRealpath: async (p) => p,
    });
    expect(lanes[0]?.label.length).toBe(200);
    expect(lanes[0]?.label.endsWith("…")).toBe(true);
    expect(lanes[0]?.items[0]?.title.length).toBe(200);
  });

  it("skips malformed lanes and items without failing the file", async () => {
    const { lanes } = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({
        schemaVersion: 1,
        lanes: [
          null,
          { id: "no-items" },
          {
            id: "ok",
            label: "Ok",
            items: [null, { title: "no id" }, { id: "good", title: "Good", state: "failed" }],
          },
        ],
      }),
      resolveRealpath: async (p) => p,
    });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.items.map((item) => item.id)).toEqual(["good"]);
  });

  it("exposes a provider wrapper with a stable id", () => {
    const provider = createJsonFileProvider("json-file", {
      rootDir: "/data/lanes",
      filePath: "board.json",
    });
    expect(provider.id).toBe("json-file");
    expect(typeof provider.load).toBe("function");
  });
});
