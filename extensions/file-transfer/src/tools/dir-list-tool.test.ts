// File Transfer tests cover dir list tool plugin behavior.
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileTransferAudit } from "../shared/audit.js";
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
  vi.mocked(appendFileTransferAudit).mockReset();
  vi.mocked(callGatewayTool).mockReset();
  vi.mocked(listNodes).mockReset();
  vi.mocked(resolveNodeIdFromList).mockReset();
});

describe("dir_list tool", () => {
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

  it("summarizes files and subdirectories from a successful listing", async () => {
    const entries = [
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
      { name: "package.json", isDir: false },
    ];
    vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1", displayName: "Node 1" }]);
    vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
    vi.mocked(callGatewayTool).mockResolvedValue({
      payload: {
        ok: true,
        path: "/tmp/project",
        entries,
        truncated: true,
        nextPageToken: "next-page",
      },
    });

    const result = await createDirListTool().execute("tool-call-1", {
      node: "node-1",
      path: "/tmp/project",
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Listed /tmp/project: 2 files, 1 subdir (more entries available — pass nextPageToken)",
      },
    ]);
    expect(result.details).toMatchObject({
      path: "/tmp/project",
      entries,
      nextPageToken: "next-page",
      truncated: true,
    });
    expect(appendFileTransferAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "dir.list",
        nodeId: "node-1",
        nodeDisplayName: "Node 1",
        requestedPath: "/tmp/project",
        canonicalPath: "/tmp/project",
        decision: "allowed",
      }),
    );
  });

  it("describes node as a paired-node reference, not a local alias", () => {
    const schema = JSON.stringify(createDirListTool().parameters);

    expect(schema).toContain("Existing paired node id");
    expect(schema).toContain("nodes status");
    expect(schema).toContain("local, host, gateway, or auto");
  });
});
