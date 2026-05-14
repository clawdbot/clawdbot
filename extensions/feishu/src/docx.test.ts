import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolFactoryHarness, type ToolLike } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuToolAccountMock = vi.hoisted(() => vi.fn());
const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const convertMock = vi.hoisted(() => vi.fn());
const documentCreateMock = vi.hoisted(() => vi.fn());
const blockListMock = vi.hoisted(() => vi.fn());
const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
const blockChildrenGetMock = vi.hoisted(() => vi.fn());
const blockChildrenBatchDeleteMock = vi.hoisted(() => vi.fn());
const blockDescendantCreateMock = vi.hoisted(() => vi.fn());
const driveUploadAllMock = vi.hoisted(() => vi.fn());
const permissionMemberCreateMock = vi.hoisted(() => vi.fn());
const blockPatchMock = vi.hoisted(() => vi.fn());
const scopeListMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");
const runtimeModule = await import("./runtime.js");

vi.spyOn(toolAccountModule, "createFeishuToolClient").mockImplementation(() =>
  createFeishuClientMock(),
);
vi.spyOn(toolAccountModule, "resolveAnyEnabledFeishuToolsConfig").mockReturnValue({
  doc: true,
  chat: false,
  wiki: false,
  drive: false,
  perm: false,
  scopes: false,
});
vi.spyOn(toolAccountModule, "resolveFeishuToolAccount").mockImplementation((...args) =>
  resolveFeishuToolAccountMock(...args),
);
vi.spyOn(runtimeModule, "getFeishuRuntime").mockImplementation(
  () =>
    ({
      channel: {
        media: {
          readRemoteMediaBuffer: readRemoteMediaBufferMock,
          saveMediaBuffer: vi.fn(),
        },
      },
      media: {
        loadWebMedia: loadWebMediaMock,
        detectMime: vi.fn(async () => "application/octet-stream"),
        mediaKindFromMime: vi.fn(() => "image"),
        isVoiceCompatibleAudio: vi.fn(() => false),
        getImageMetadata: vi.fn(async () => null),
        resizeToJpeg: vi.fn(async () => Buffer.alloc(0)),
      },
    }) as unknown as ReturnType<typeof runtimeModule.getFeishuRuntime>,
);

const { registerFeishuDocTools } = await import("./docx.js");

type ToolResultWithDetails = {
  details: Record<string, unknown>;
};

const WORKSPACE_ROOT = path.resolve("/workspace");

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[argIndex];
}

function expectLoadWebMediaCall(fileName: string, localRoots: unknown[] | undefined) {
  const source = callArg(loadWebMediaMock, 0, 0, "loadWebMedia source");
  const options = requireRecord(
    callArg(loadWebMediaMock, 0, 1, "loadWebMedia options"),
    "loadWebMedia options",
  );
  expect(String(source)).toContain(fileName);
  expect(options.optimizeImages).toBe(false);
  expect(options.localRoots).toEqual(localRoots);
}

describe("feishu_doc image fetch hardening", () => {
  afterAll(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      docx: {
        document: {
          convert: convertMock,
          create: documentCreateMock,
        },
        documentBlock: {
          list: blockListMock,
          patch: blockPatchMock,
        },
        documentBlockChildren: {
          create: blockChildrenCreateMock,
          get: blockChildrenGetMock,
          batchDelete: blockChildrenBatchDeleteMock,
        },
        documentBlockDescendant: {
          create: blockDescendantCreateMock,
        },
      },
      drive: {
        media: {
          uploadAll: driveUploadAllMock,
        },
        permissionMember: {
          create: permissionMemberCreateMock,
        },
      },
      application: {
        scope: {
          list: scopeListMock,
        },
      },
    });
    resolveFeishuToolAccountMock.mockReturnValue({
      config: { mediaMaxMb: 30 },
    });

    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks: [{ block_type: 27 }],
        first_level_block_ids: [],
      },
    });

    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: [],
      },
    });

    blockChildrenCreateMock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_type: 27, block_id: "img_block_1" }],
      },
    });

    blockChildrenGetMock.mockResolvedValue({
      code: 0,
      data: { items: [{ block_id: "placeholder_block_1" }] },
    });
    blockChildrenBatchDeleteMock.mockResolvedValue({ code: 0 });
    // write/append use Descendant API; return image block so processImages runs
    blockDescendantCreateMock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_type: 27, block_id: "img_block_1" }] },
    });
    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
    documentCreateMock.mockResolvedValue({
      code: 0,
      data: { document: { document_id: "doc_created", title: "Created Doc" } },
    });
    permissionMemberCreateMock.mockResolvedValue({ code: 0 });
    blockPatchMock.mockResolvedValue({ code: 0 });
    scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });
  });

  function resolveFeishuDocTool(context: Record<string, unknown> = {}) {
    const harness = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          appId: "app_id",
          appSecret: "app_secret",
        },
      },
    });
    registerFeishuDocTools(harness.api);
    const tool = harness.resolveTool("feishu_doc", context);
    if (!tool) {
      throw new Error("expected Feishu doc tool");
    }
    return tool;
  }

  async function executeFeishuDocTool(
    tool: ToolLike,
    params: Record<string, unknown>,
  ): Promise<ToolResultWithDetails> {
    return (await tool.execute("tool-call", params)) as ToolResultWithDetails;
  }

  it("inserts blocks sequentially to preserve document order", async () => {
    const blocks = [
      { block_type: 3, block_id: "h1" },
      { block_type: 2, block_id: "t1" },
      { block_type: 3, block_id: "h2" },
    ];
    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks,
        first_level_block_ids: ["h1", "t1", "h2"],
      },
    });

    blockListMock.mockResolvedValue({ code: 0, data: { items: [] } });

    blockDescendantCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { children: [{ block_type: 3, block_id: "h1" }] },
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "append",
      doc_token: "doc_1",
      content: "plain text body",
    });

    expect(blockDescendantCreateMock).toHaveBeenCalledTimes(1);
    const call = blockDescendantCreateMock.mock.calls[0]?.[0];
    expect(call?.data.children_id).toEqual(["h1", "t1", "h2"]);
    expect(call?.data.descendants).toEqual(blocks);

    expect(result.details.blocks_added).toBe(3);
  });

  it("reorders convert output by document tree instead of raw block array order", async () => {
    const blocks = [
      { block_type: 13, block_id: "li2", parent_id: "list1" },
      { block_type: 4, block_id: "h2" },
      { block_type: 13, block_id: "li1", parent_id: "list1" },
      { block_type: 3, block_id: "h1" },
      { block_type: 12, block_id: "list1", children: ["li1", "li2"] },
      { block_type: 2, block_id: "p1" },
    ];
    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks,
        first_level_block_ids: ["h1", "p1", "h2", "list1"],
      },
    });

    blockDescendantCreateMock.mockImplementationOnce(async ({ data }) => ({
      code: 0,
      data: {
        children: (data.children_id as string[]).map((id) => ({ block_id: id })),
      },
    }));

    const feishuDocTool = resolveFeishuDocTool();

    await feishuDocTool.execute("tool-call", {
      action: "append",
      doc_token: "doc_1",
      content: "tree reorder",
    });

    const call = blockDescendantCreateMock.mock.calls[0]?.[0];
    expect(call?.data.children_id).toEqual(["h1", "p1", "h2", "list1"]);
    expect((call?.data.descendants as Array<{ block_id: string }>).map((b) => b.block_id)).toEqual([
      "h1",
      "p1",
      "h2",
      "list1",
      "li1",
      "li2",
    ]);
  });

  it("falls back to size-based convert chunking for long no-heading markdown", async () => {
    let successChunkCount = 0;
    convertMock.mockImplementation(async ({ data }) => {
      const content = data.content as string;
      if (content.length > 280) {
        return { code: 999, msg: "content too large" };
      }
      successChunkCount++;
      const blockId = `b_${successChunkCount}`;
      return {
        code: 0,
        data: {
          blocks: [{ block_type: 2, block_id: blockId }],
          first_level_block_ids: [blockId],
        },
      };
    });

    blockDescendantCreateMock.mockImplementation(async ({ data }) => ({
      code: 0,
      data: {
        children: (data.children_id as string[]).map((id) => ({
          block_id: id,
        })),
      },
    }));

    const feishuDocTool = resolveFeishuDocTool();

    const longMarkdown = Array.from(
      { length: 120 },
      (_, i) => `line ${i} with enough content to trigger fallback chunking`,
    ).join("\n");

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "append",
      doc_token: "doc_1",
      content: longMarkdown,
    });

    expect(convertMock.mock.calls.length).toBeGreaterThan(1);
    expect(successChunkCount).toBeGreaterThan(1);
    expect(result.details.blocks_added).toBe(successChunkCount);
  });

  it("keeps fenced code blocks balanced when size fallback split is needed", async () => {
    const convertedChunks: string[] = [];
    let successChunkCount = 0;
    let failFirstConvert = true;
    convertMock.mockImplementation(async ({ data }) => {
      const content = data.content as string;
      convertedChunks.push(content);
      if (failFirstConvert) {
        failFirstConvert = false;
        return { code: 999, msg: "content too large" };
      }
      successChunkCount++;
      const blockId = `c_${successChunkCount}`;
      return {
        code: 0,
        data: {
          blocks: [{ block_type: 2, block_id: blockId }],
          first_level_block_ids: [blockId],
        },
      };
    });

    blockChildrenCreateMock.mockImplementation(async ({ data }) => ({
      code: 0,
      data: { children: data.children },
    }));

    const feishuDocTool = resolveFeishuDocTool();

    const fencedMarkdown = [
      "## Section",
      "```ts",
      "const alpha = 1;",
      "const beta = 2;",
      "const gamma = alpha + beta;",
      "console.log(gamma);",
      "```",
      "",
      "Tail paragraph one with enough text to exceed API limits when combined. ".repeat(8),
      "Tail paragraph two with enough text to exceed API limits when combined. ".repeat(8),
      "Tail paragraph three with enough text to exceed API limits when combined. ".repeat(8),
    ].join("\n");

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "append",
      doc_token: "doc_1",
      content: fencedMarkdown,
    });

    expect(convertMock.mock.calls.length).toBeGreaterThan(1);
    expect(successChunkCount).toBeGreaterThan(1);
    for (const chunk of convertedChunks) {
      const fenceCount = chunk.match(/```/g)?.length ?? 0;
      expect(fenceCount % 2).toBe(0);
    }
    expect(result.details.blocks_added).toBe(successChunkCount);
  });

  it("skips image upload when markdown image URL is blocked", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readRemoteMediaBufferMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "write",
      doc_token: "doc_1",
      content: "![x](https://x.test/image.png)",
    });

    expect(readRemoteMediaBufferMock).toHaveBeenCalled();
    expect(driveUploadAllMock).not.toHaveBeenCalled();
    expect(blockPatchMock).not.toHaveBeenCalled();
    expect(result.details.images_processed).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("create grants permission only to trusted Feishu requester", async () => {
    const feishuDocTool = resolveFeishuDocTool({
      messageChannel: "feishu",
      requesterSenderId: "ou_123",
    });

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
    });

    expect(result.details.document_id).toBe("doc_created");
    expect(result.details.requester_permission_added).toBe(true);
    expect(result.details.requester_open_id).toBe("ou_123");
    expect(result.details.requester_perm_type).toBe("edit");
    const permissionPayload = requireRecord(
      callArg(permissionMemberCreateMock, 0, 0, "permission create payload"),
      "permission create payload",
    );
    const permissionData = requireRecord(permissionPayload.data, "permission data");
    expect(permissionData.member_type).toBe("openid");
    expect(permissionData.member_id).toBe("ou_123");
    expect(permissionData.perm).toBe("edit");
  });

  it("create skips requester grant when trusted requester identity is unavailable", async () => {
    const feishuDocTool = resolveFeishuDocTool({
      messageChannel: "feishu",
    });

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
    });

    expect(permissionMemberCreateMock).not.toHaveBeenCalled();
    expect(result.details.requester_permission_added).toBe(false);
    expect(result.details.requester_permission_skipped_reason).toContain("trusted requester");
  });

  it("create never grants permissions when grant_to_requester is false", async () => {
    const feishuDocTool = resolveFeishuDocTool({
      messageChannel: "feishu",
      requesterSenderId: "ou_123",
    });

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
      grant_to_requester: false,
    });

    expect(permissionMemberCreateMock).not.toHaveBeenCalled();
    expect(result.details.requester_permission_added).toBeUndefined();
  });

  it("returns an error when create response omits document_id", async () => {
    documentCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { document: { title: "Created Doc" } },
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
    });

    expect(result.details.error).toContain("no document_id");
  });

  it("uploads local file to doc via upload_file action", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 23, block_id: "file_block_1" }],
      },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/allowed/test-local.txt",
      filename: "test-local.txt",
    });

    expect(result.details.success).toBe(true);
    expect(result.details.file_token).toBe("token_1");
    expect(result.details.file_name).toBe("test-local.txt");

    // Without workspace-only policy, localRoots stays undefined so loadWebMedia
    // applies its default managed-root access behavior.
    expectLoadWebMediaCall("test-local.txt", undefined);

    const uploadPayload = requireRecord(
      callArg(driveUploadAllMock, 0, 0, "drive upload payload"),
      "drive upload payload",
    );
    const uploadData = requireRecord(uploadPayload.data, "drive upload data");
    expect(uploadData.parent_type).toBe("docx_file");
    expect(uploadData.parent_node).toBe("doc_1");
    expect(uploadData.file_name).toBe("test-local.txt");
  });

  it("passes workspace localRoots for upload_file when workspace-only policy is active", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 23, block_id: "file_block_1" }],
      },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool({
      workspaceDir: WORKSPACE_ROOT,
      fsPolicy: { workspaceOnly: true },
    });

    await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/openclaw-1000/test-local.txt",
      filename: "test-local.txt",
    });

    expectLoadWebMediaCall("test-local.txt", [WORKSPACE_ROOT]);
  });

  it("passes empty localRoots when workspace-only policy is active without workspaceDir", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 23, block_id: "file_block_1" }],
      },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool({
      fsPolicy: { workspaceOnly: true },
    });

    await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/openclaw-1000/test-local.txt",
      filename: "test-local.txt",
    });

    expectLoadWebMediaCall("test-local.txt", []);
  });

  it("passes workspace localRoots for upload_image local paths when workspace-only policy is active", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.png",
    });

    const feishuDocTool = resolveFeishuDocTool({
      workspaceDir: WORKSPACE_ROOT,
      fsPolicy: { workspaceOnly: true },
    });

    await executeFeishuDocTool(feishuDocTool, {
      action: "upload_image",
      doc_token: "doc_1",
      image: "./test-local.png",
      filename: "test-local.png",
    });

    expectLoadWebMediaCall("test-local.png", [WORKSPACE_ROOT]);
  });

  it("passes workspace localRoots for upload_image absolute local paths when workspace-only policy is active", async () => {
    const fixtureDir = path.join(process.cwd(), ".tmp-docx-upload-image-absolute");
    const absoluteImagePath = path.join(fixtureDir, "absolute-image.png");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(absoluteImagePath, "not-real-image");

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "absolute-image.png",
    });

    const feishuDocTool = resolveFeishuDocTool({
      workspaceDir: WORKSPACE_ROOT,
      fsPolicy: { workspaceOnly: true },
    });

    try {
      await executeFeishuDocTool(feishuDocTool, {
        action: "upload_image",
        doc_token: "doc_1",
        image: absoluteImagePath,
        filename: "absolute-image.png",
      });

      expectLoadWebMediaCall("absolute-image.png", [WORKSPACE_ROOT]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("returns an error when upload_file cannot list placeholder siblings", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 23, block_id: "file_block_1" }],
      },
    });
    blockChildrenGetMock.mockResolvedValueOnce({
      code: 999,
      msg: "list failed",
      data: { items: [] },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/allowed/test-local.txt",
      filename: "test-local.txt",
    });

    expect(result.details.error).toBe("list failed");
    expect(driveUploadAllMock).not.toHaveBeenCalled();
  });

  it("rejects traversal paths in upload_file via loadWebMedia sandbox", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Local media path is not under an allowed directory: /etc/passwd"),
    );

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/etc/passwd",
    });

    expect(result.details.error).toContain("not under an allowed directory");
    expect(driveUploadAllMock).not.toHaveBeenCalled();
  });

  it("rejects traversal paths in upload_image via loadWebMedia sandbox", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 27, block_id: "img_block_1" }],
      },
    });

    loadWebMediaMock.mockRejectedValueOnce(
      new Error(
        "Local media path is not under an allowed directory: /home/admin/.openclaw/openclaw.json",
      ),
    );

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_image",
      doc_token: "doc_1",
      file_path: "/home/admin/.openclaw/openclaw.json",
    });

    expect(result.details.error).toContain("not under an allowed directory");
    expect(driveUploadAllMock).not.toHaveBeenCalled();
  });
});
