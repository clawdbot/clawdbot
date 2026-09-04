// File Transfer tests cover dir list tool plugin behavior.
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import pluginEntry from "../../index.js";
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
      { name: "report.txt", isDir: false },
      { name: "nested", isDir: true },
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

    expect(result.content).toEqual([
      {
        type: "text",
        text: 'Listed /tmp/project: 1 file, 1 subdir (more entries available). Call dir_list again with pageToken="3".',
      },
    ]);
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

      expect(result.content).toEqual([
        { type: "text", text: "Listed /tmp/project: 0 files, 0 subdirs (more entries available)" },
      ]);
      expect(result.details).toEqual({
        path: "/tmp/project",
        entries: [],
        nextPageToken,
        truncated: true,
      });
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
