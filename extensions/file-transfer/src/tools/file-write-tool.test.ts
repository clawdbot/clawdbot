// File Transfer tests cover file write tool plugin behavior.
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { humanSize } from "../shared/params.js";
import { FILE_WRITE_HARD_MAX_BYTES } from "./descriptors.js";
import { createFileWriteTool } from "./file-write-tool.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  readMediaBuffer: vi.fn(),
}));

vi.mock("../shared/audit.js", () => ({
  appendFileTransferAudit: vi.fn(),
}));

describe("file_write tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed inline base64 before invoking the node", async () => {
    const tool = createFileWriteTool();

    await expect(
      tool.execute("tool-call-1", {
        node: "node-1",
        path: "/tmp/out.txt",
        contentBase64: "AAA@@@",
      }),
    ).rejects.toThrow("contentBase64 is not valid base64");

    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects oversized inline base64 before invoking the node", async () => {
    const tool = createFileWriteTool();
    const encodedLength = Math.ceil(((FILE_WRITE_HARD_MAX_BYTES + 1) * 4) / 3);
    const contentBase64 = "A".repeat(encodedLength);

    await expect(
      tool.execute("tool-call-1", {
        node: "node-1",
        path: "/tmp/out.bin",
        contentBase64,
      }),
    ).rejects.toThrow(
      `decoded content is ${FILE_WRITE_HARD_MAX_BYTES + 1} bytes; maximum is ${FILE_WRITE_HARD_MAX_BYTES} bytes (${humanSize(FILE_WRITE_HARD_MAX_BYTES)})`,
    );

    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects whitespace-heavy malformed input without decoding or dispatching", async () => {
    const bufferFrom = vi.spyOn(Buffer, "from");
    const tool = createFileWriteTool();

    await expect(
      tool.execute("tool-call-1", {
        node: "node-1",
        path: "/tmp/out.bin",
        contentBase64: " ".repeat(1024 * 1024),
      }),
    ).rejects.toThrow("contentBase64 is not valid base64");

    expect(bufferFrom).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("accepts exactly 16 MiB of inline data", async () => {
    vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1", displayName: "Node 1" }]);
    vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
    vi.mocked(callGatewayTool).mockResolvedValue({
      payload: {
        ok: true,
        path: "/tmp/out.bin",
        size: FILE_WRITE_HARD_MAX_BYTES,
        sha256: "a".repeat(64),
        overwritten: false,
      },
    });
    const tool = createFileWriteTool();
    const contentBase64 = Buffer.alloc(FILE_WRITE_HARD_MAX_BYTES).toString("base64");

    await expect(
      tool.execute("tool-call-1", {
        node: "node-1",
        path: "/tmp/out.bin",
        contentBase64,
      }),
    ).resolves.toMatchObject({ details: { size: FILE_WRITE_HARD_MAX_BYTES } });

    expect(callGatewayTool).toHaveBeenCalledOnce();
  });
});
