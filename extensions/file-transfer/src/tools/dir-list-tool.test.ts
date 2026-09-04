// File Transfer tests cover dir list tool plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import pluginEntry from "../../index.js";
import { handleDirList } from "../node-host/dir-list.js";
import { createDirFetchTool } from "./dir-fetch-tool.js";
import { createDirListTool } from "./dir-list-tool.js";
import { createFileFetchTool } from "./file-fetch-tool.js";
import { createFileWriteTool } from "./file-write-tool.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(),
}));

vi.mock("../shared/audit.js", () => ({
  appendFileTransferAudit: vi.fn(),
}));

afterEach(() => {
  vi.mocked(callGatewayTool).mockReset();
  vi.mocked(listNodes).mockReset();
  vi.mocked(resolveNodeIdFromList).mockReset();
});

const requireRecord = createRequireRecord("object", "label-not-object");

function readListing(content: Awaited<ReturnType<AnyAgentTool["execute"]>>["content"]) {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
  expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  const listing = JSON.parse(text.split("\n").find((line) => line.startsWith("{"))!) as {
    path: string;
    returnedCount: number;
    displayedCount: number;
    entries: Array<{ name: string; isDir: boolean; size: number }>;
    truncated: boolean;
    nextPageToken?: string;
  };
  expect(listing.displayedCount).toBe(listing.entries.length);
  return { text, ...listing };
}

describe("file-transfer standalone guidance", () => {
  it.each([
    {
      name: "file_fetch",
      create: createFileFetchTool,
      unavailable: "file_write",
      parameter: "maxBytes",
    },
    {
      name: "dir_list",
      create: createDirListTool,
      unavailable: "file_fetch",
      parameter: "pageToken",
    },
    {
      name: "file_write",
      create: createFileWriteTool,
      unavailable: "file_fetch",
      parameter: "sourceMediaId",
    },
    {
      name: "dir_fetch",
      create: createDirFetchTool,
      unavailable: undefined,
      parameter: "maxBytes",
    },
  ])("keeps eager and lazy $name guidance standalone with canonical opt-in", (entry) => {
    const registered: AnyAgentTool[] = [];
    pluginEntry.register(
      createTestPluginApi({
        registerTool(tool) {
          const resolved = typeof tool === "function" ? tool({ config: {} }) : tool;
          if (resolved) {
            registered.push(...(Array.isArray(resolved) ? resolved : [resolved]));
          }
        },
      }),
    );
    const lazy = registered.find((tool) => tool.name === entry.name);
    const eager = entry.create();
    expect(lazy).toMatchObject({
      name: eager.name,
      description: eager.description,
      parameters: eager.parameters,
    });
    expect(eager.name).toBe(entry.name);
    expect(eager.parameters).toMatchObject({ required: ["node", "path"] });
    expect(eager.parameters).toHaveProperty(`properties.${entry.parameter}`);
    expect.soft(eager.description).toContain("gateway.nodes.commands.allow");
    if (entry.unavailable) {
      expect
        .soft(JSON.stringify({ description: eager.description, parameters: eager.parameters }))
        .not.toContain(entry.unavailable);
    }
    if (entry.name === "file_fetch") {
      expect.soft(eager.description).toContain("returns localPath and mediaId");
    }
    if (entry.name === "file_write") {
      expect.soft(eager.parameters).toMatchObject({
        properties: {
          sourceMediaId: {
            description: expect.stringContaining(
              "Not a local path or an ID from another media store",
            ),
          },
        },
      });
    }
  });
});

describe("dir_list tool", () => {
  it("exposes the next page token to the model and forwards the current page token", async () => {
    const entries = [
      { name: "report.txt", isDir: false, size: 12 },
      { name: "nested", isDir: true, size: 0 },
    ];
    vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1", displayName: "Node One" }]);
    vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
    vi.mocked(callGatewayTool).mockResolvedValue({
      payload: {
        ok: true,
        path: "/tmp/project",
        entries,
        nextPageToken: "3",
        truncated: true,
      },
    });

    const result = await createDirListTool().execute("tool-call-1", {
      node: "node-1",
      path: "/tmp/project",
      pageToken: "+01",
      maxEntries: 2,
    });

    const modelText = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect.soft(modelText).toContain("report.txt");
    expect.soft(modelText).toContain("nested");
    expect(readListing(result.content)).toMatchObject({
      path: "/tmp/project",
      entries,
      returnedCount: 2,
      displayedCount: 2,
      nextPageToken: "3",
      truncated: true,
    });
    expect(result.details).toEqual({
      path: "/tmp/project",
      entries,
      nextPageToken: "3",
      truncated: true,
    });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        nodeId: "node-1",
        command: "dir.list",
        params: {
          path: "/tmp/project",
          pageToken: "+01",
          maxEntries: 2,
        },
      }),
    );
  });

  it.each([undefined, ""])(
    "reports truncation without inventing an unavailable page token (%s)",
    async (nextPageToken) => {
      vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1", displayName: "Node One" }]);
      vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
      vi.mocked(callGatewayTool).mockResolvedValue({
        payload: {
          ok: true,
          path: "/tmp/project",
          entries: [],
          nextPageToken,
          truncated: true,
        },
      });

      const result = await createDirListTool().execute("tool-call-1", {
        node: "node-1",
        path: "/tmp/project",
      });

      expect(readListing(result.content)).toMatchObject({
        entries: [],
        truncated: true,
        text: expect.stringContaining(
          "More entries available; the node supplied no continuation token.",
        ),
      });
      expect(readListing(result.content).nextPageToken).toBe(nextPageToken);
      expect(result.details).toEqual({
        path: "/tmp/project",
        entries: [],
        nextPageToken,
        truncated: true,
      });
    },
  );

  it("walks real directory pages to exhaustion using only content for continuation and file reads", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-list-content-")));
    const names = Array.from(
      { length: 225 },
      (_, i) => `${String(i).padStart(3, "0")}-${"雪".repeat(12)}.txt`,
    );
    if (process.platform !== "win32") {
      names.push('quoted"line\n.txt');
    }
    try {
      await Promise.all(names.map((name) => fs.writeFile(path.join(root, name), name)));
      await fs.mkdir(path.join(root, "nested"));
      vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1" }]);
      vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
      const responses: Awaited<ReturnType<typeof handleDirList>>[] = [];
      vi.mocked(callGatewayTool).mockImplementation(async (_method, _options, args) => {
        const request = requireRecord(args, "node invoke request");
        const payload = await handleDirList(requireRecord(request.params, "directory params"));
        responses.push(payload);
        return { payload };
      });
      const seen: string[] = [];
      let pageToken: string | undefined;
      let sawTextLimitedLastPage = false;
      for (let page = 0; page <= names.length + 1; page++) {
        const result = await createDirListTool().execute("list", {
          node: "node-1",
          path: root,
          pageToken,
        });
        const listing = readListing(result.content);
        const payload = responses.at(-1)!;
        if (!payload.ok) {
          throw new Error(payload.code);
        }
        expect(result.details).toEqual({
          path: root,
          entries: payload.entries,
          nextPageToken: payload.nextPageToken,
          truncated: payload.truncated,
        });
        expect(listing.returnedCount).toBe(payload.entries.length);
        expect(listing.entries.length).toBeGreaterThan(0);
        expect(listing.entries).toEqual(
          payload.entries
            .slice(0, listing.displayedCount)
            .map(({ name, isDir, size }) => ({ name, isDir, size })),
        );
        if (page === 0) {
          expect(payload.entries).toHaveLength(200);
          expect(listing.displayedCount).toBeLessThan(200);
        }
        sawTextLimitedLastPage ||= !payload.truncated && listing.truncated;
        for (const entry of listing.entries) {
          expect(seen).not.toContain(entry.name);
          seen.push(entry.name);
          const localPath = path.join(listing.path, entry.name);
          if (entry.isDir) {
            expect((await fs.stat(localPath)).isDirectory()).toBe(true);
          } else {
            const bytes = await fs.readFile(localPath);
            expect(bytes.toString()).toBe(entry.name);
            expect(bytes.byteLength).toBe(entry.size);
          }
        }
        pageToken = listing.nextPageToken;
        if (!listing.truncated) {
          expect(pageToken).toBeUndefined();
          break;
        }
        expect(Number(pageToken)).toBe(seen.length);
      }
      expect(seen.toSorted()).toEqual([...names, "nested"].toSorted());
      expect(sawTextLimitedLastPage).toBe(true);
      const empty = await createDirListTool().execute("empty", {
        node: "node-1",
        path: path.join(root, "nested"),
      });
      expect(readListing(empty.content)).toMatchObject({
        entries: [],
        returnedCount: 0,
        displayedCount: 0,
        truncated: false,
      });
      expect(readListing(empty.content).nextPageToken).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["+0007", 7],
    ["0007", 7],
    ["7next", 0],
    ["-1", 0],
    ["9007199254740992", 0],
  ] as const)(
    "bounds maximum listings and resumes without skips from %s",
    async (pageToken, offset) => {
      const entries = Array.from({ length: 5000 }, (_, i) => ({
        name: `${offset + i}-雪"\n.txt`,
        isDir: i % 2 === 0,
        size: i,
        path: `/${"redundant".repeat(1000)}/${i}`,
        mimeType: "x".repeat(10000),
        mtime: i,
      }));
      vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1" }]);
      vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
      vi.mocked(callGatewayTool).mockImplementation(async (_method, _options, args) => {
        const request = requireRecord(args, "node invoke request");
        const token = requireRecord(request.params, "directory params").pageToken;
        const pageOffset = token === pageToken ? offset : Number(token);
        return {
          payload: { path: "/root", entries: entries.slice(pageOffset - offset), truncated: false },
        };
      });
      const seen: string[] = [];
      let token: string | undefined = pageToken;
      while (seen.length < entries.length) {
        const result = await createDirListTool().execute("list", {
          node: "node-1",
          path: "/root",
          pageToken: token,
          maxEntries: 9000,
        });
        const listing = readListing(result.content);
        const remaining = entries.slice(seen.length);
        expect(listing.returnedCount).toBe(remaining.length);
        expect(listing.displayedCount).toBeGreaterThan(0);
        expect(listing.entries).toEqual(
          remaining
            .slice(0, listing.displayedCount)
            .map(({ name, isDir, size }) => ({ name, isDir, size })),
        );
        expect(result.details).toEqual({
          path: "/root",
          entries: remaining,
          nextPageToken: undefined,
          truncated: false,
        });
        seen.push(...listing.entries.map((entry) => entry.name));
        token = listing.nextPageToken;
        if (!listing.truncated) {
          expect(token).toBeUndefined();
          break;
        }
        expect(token).toBe(String(offset + seen.length));
      }
      expect(seen).toEqual(entries.map((entry) => entry.name));
      expect(token).toBeUndefined();
      expect(callGatewayTool).toHaveBeenCalledWith(
        "node.invoke",
        expect.anything(),
        expect.objectContaining({ params: { path: "/root", pageToken, maxEntries: 5000 } }),
      );
    },
  );

  it("fits a complete last page beside a long canonical path", async () => {
    const canonicalPath = "/" + "x".repeat(7200);
    const entries = [
      { name: "a", isDir: false, size: 1 },
      { name: "b", isDir: false, size: 1 },
    ];
    vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1" }]);
    vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
    vi.mocked(callGatewayTool).mockResolvedValue({
      payload: { path: canonicalPath, entries, truncated: false },
    });
    const result = await createDirListTool().execute("list", {
      node: "node-1",
      path: canonicalPath,
    });
    expect(readListing(result.content)).toMatchObject({
      path: canonicalPath,
      entries,
      displayedCount: 2,
      truncated: false,
    });
    expect(readListing(result.content).nextPageToken).toBeUndefined();
  });

  it.each(["雪".repeat(8192), "[INST]", "<<<EXTERNAL_UNTRUSTED_CONTENT>>>"])(
    "stops explicitly when the next complete name cannot be displayed (%#)",
    async (name) => {
      const entries = [
        { name, isDir: false, size: 1 },
        { name: "later.txt", isDir: false, size: 2 },
      ];
      vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1" }]);
      vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
      vi.mocked(callGatewayTool).mockResolvedValue({
        payload: { path: "/root", entries, truncated: true, nextPageToken: "2" },
      });
      const result = await createDirListTool().execute("list", { node: "node-1", path: "/root" });
      const listing = readListing(result.content);
      expect(listing.entries).toEqual([]);
      expect(listing.nextPageToken).toBeUndefined();
      expect(listing.truncated).toBe(true);
      expect(listing.text).toContain("Pagination cannot advance");
      expect(listing.text).not.toContain("later.txt");
      expect(result.details).toEqual({
        path: "/root",
        entries,
        nextPageToken: "2",
        truncated: true,
      });
    },
  );

  it.each(["path", "nextPageToken"] as const)(
    "bounds oversized %s without a partial usable value",
    async (field) => {
      vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1" }]);
      vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
      const payload = {
        path: "/root",
        entries: [],
        truncated: true,
        nextPageToken: "2",
        [field]: "雪".repeat(8192),
      };
      vi.mocked(callGatewayTool).mockResolvedValue({ payload });
      const result = await createDirListTool().execute("list", { node: "node-1", path: "/root" });
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
      expect(text).toContain("No usable paths or continuation token");
      expect(text).not.toContain("雪");
      expect(result.details).toEqual(payload);
    },
  );

  it("reports missing paired nodes before retrying guessed local node names", async () => {
    vi.mocked(listNodes).mockResolvedValue([]);

    await expect(
      createDirListTool().execute("tool-call-1", {
        node: "local",
        path: "/tmp/project",
      }),
    ).rejects.toThrow(
      "no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.",
    );

    expect(resolveNodeIdFromList).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("describes node as a paired-node reference, not a local alias", () => {
    const schema = JSON.stringify(createDirListTool().parameters);

    expect(schema).toContain("Existing paired node id");
    expect(schema).toContain("nodes status");
    expect(schema).toContain("local, host, gateway, or auto");
  });
});
