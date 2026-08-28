// File Transfer tests cover dir list tool plugin behavior.
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirListTool } from "./dir-list-tool.js";

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
