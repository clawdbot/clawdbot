// JSON-file task-lane provider: path safety, bounds, URL sanitization.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TASK_LANE_MAX_FILE_BYTES } from "../types.js";
import { createJsonFileProvider, type JsonFileProviderOptions } from "./json-file-provider.js";

/** Exercises the module's internal loader through the exported provider wrapper. */
const loadJsonFileProviderLanes = async (options: JsonFileProviderOptions) =>
  createJsonFileProvider("json-file", options).load();

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

describe("json-file provider duplicate lane ids", () => {
  it("rejects two lanes sharing an id within one provider document", async () => {
    const duplicate = {
      schemaVersion: 1,
      lanes: [
        { id: "work", label: "Work", items: [{ id: "a", title: "A", state: "pending" }] },
        { id: "work", label: "Work mirror", items: [{ id: "b", title: "B", state: "pending" }] },
      ],
    };
    await expect(
      loadJsonFileProviderLanes({
        rootDir: "/data/lanes",
        filePath: "board.json",
        reader: readerReturning(duplicate),
        resolveRealpath: async (p) => p,
      }),
    ).rejects.toThrow(/duplicate lane id/);
  });
});

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

  it("bounds the production read before allocating an oversized file", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "task-lane-cap-"));
    try {
      const root = path.join(tmp, "root");
      await fs.mkdir(root);
      const board = path.join(root, "board.json");
      await fs.writeFile(board, "x", { flag: "wx" });
      await fs.truncate(board, TASK_LANE_MAX_FILE_BYTES + 1);
      const readFileSpy = vi.spyOn(fs, "readFile");
      try {
        await expect(
          loadJsonFileProviderLanes({ rootDir: root, filePath: "board.json" }),
        ).rejects.toThrow(/too large/);
        // The unbounded whole-file read is the allocation the cap must precede.
        expect(readFileSpy).not.toHaveBeenCalled();
      } finally {
        readFileSpy.mockRestore();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("never echoes filesystem paths in load errors", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "task-lane-msg-"));
    try {
      const root = path.join(tmp, "root");
      const outside = path.join(tmp, "outside.json");
      await fs.mkdir(root);
      await fs.writeFile(outside, JSON.stringify(VALID_DOC));
      await fs.symlink(outside, path.join(root, "link.json"));
      // A directory where the config expects a file: readFile fails with EISDIR
      // regardless of the effective uid (a chmod-000 probe would not).
      await fs.mkdir(path.join(root, "adir.json"));
      const cases: Array<{ rootDir: string; filePath: string; fragment: string }> = [
        { rootDir: root, filePath: "link.json", fragment: outside },
        { rootDir: root, filePath: "nope.json", fragment: path.join(root, "nope.json") },
        { rootDir: root, filePath: "adir.json", fragment: path.join(root, "adir.json") },
      ];
      for (const probe of cases) {
        const error: unknown = await loadJsonFileProviderLanes(probe).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).not.toContain(probe.fragment);
        expect(message).not.toContain(tmp);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON without echoing file content", async () => {
    const error: unknown = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: async () => Buffer.from('{"schemaVersion": 1, "lanes": "sentinel-LEAK"', "utf8"),
      resolveRealpath: async (p) => p,
    }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("sentinel-LEAK");
    expect((error as Error).message).toMatch(/not valid JSON/);
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

  it("reports an unsupported schemaVersion without echoing the file's value", async () => {
    const error: unknown = await loadJsonFileProviderLanes({
      rootDir: "/data/lanes",
      filePath: "board.json",
      reader: readerReturning({ ...VALID_DOC, schemaVersion: "sentinel-LEAK<img src=x>" }),
      resolveRealpath: async (p) => p,
    }).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toMatch(/schemaVersion/);
    expect(message).not.toContain("sentinel-LEAK");
    expect(message).not.toContain("<img");
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
