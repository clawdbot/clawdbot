import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let configOverride: Record<string, unknown> = {
  ...createSubagentSpawnTestConfig(),
};
let workspaceDirOverride = "";
let subagentSpawnModule: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

beforeAll(async () => {
  subagentSpawnModule = await loadSubagentSpawnModuleForTest({
    callGatewayMock,
    getRuntimeConfig: () => configOverride,
    updateSessionStoreMock,
    workspaceDir: workspaceDirOverride || os.tmpdir(),
  });
});

// --- decodeStrictBase64 ---

describe("decodeStrictBase64", () => {
  const maxBytes = 1024;

  it("valid base64 returns buffer with correct bytes", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    const input = "hello world";
    const encoded = Buffer.from(input).toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result).not.toBeNull();
    expect(result?.toString("utf8")).toBe(input);
  });

  it("empty string returns null", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("", maxBytes)).toBeNull();
  });

  it("bad padding (length % 4 !== 0) returns null", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("abc", maxBytes)).toBeNull();
  });

  it("non-base64 chars returns null", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("!@#$", maxBytes)).toBeNull();
  });

  it("whitespace-only returns null (empty after strip)", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("   ", maxBytes)).toBeNull();
  });

  it("pre-decode oversize guard: encoded string > maxEncodedBytes * 2 returns null", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    // maxEncodedBytes = ceil(1024/3)*4 = 1368; *2 = 2736
    const oversized = "A".repeat(2737);
    expect(decodeStrictBase64(oversized, maxBytes)).toBeNull();
  });

  it("decoded byteLength exceeds maxDecodedBytes returns null", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    const bigBuf = Buffer.alloc(1025, 0x42);
    const encoded = bigBuf.toString("base64");
    expect(decodeStrictBase64(encoded, maxBytes)).toBeNull();
  });

  it("valid base64 at exact boundary returns Buffer", async () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    const exactBuf = Buffer.alloc(1024, 0x41);
    const encoded = exactBuf.toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result).not.toBeNull();
    expect(result?.byteLength).toBe(1024);
  });
});

// --- filename validation via spawnSubagentDirect ---

describe("spawnSubagentDirect filename validation", () => {
  beforeEach(async () => {
    workspaceDirOverride = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-attachments-${process.pid}-${Date.now()}-`),
    );
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride);
    subagentSpawnModule.resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    updateSessionStoreMock.mockReset();
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    if (workspaceDirOverride) {
      fs.rmSync(workspaceDirOverride, { recursive: true, force: true });
      workspaceDirOverride = "";
    }
  });

  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "forum" as const,
    agentAccountId: "123",
    agentTo: "456",
  };

  const validContent = Buffer.from("hello").toString("base64");

  async function spawnWithName(name: string) {
    const { spawnSubagentDirect } = subagentSpawnModule;
    return spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name, content: validContent, encoding: "base64" }],
      },
      ctx,
    );
  }

  it("name with / returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo/bar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '..' returns attachments_invalid_name", async () => {
    const result = await spawnWithName("..");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '.manifest.json' returns attachments_invalid_name", async () => {
    const result = await spawnWithName(".manifest.json");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo\nbar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "file.txt", content: validContent, encoding: "base64" },
          { name: "file.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("empty name returns attachments_invalid_name", async () => {
    const result = await spawnWithName("");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("removes materialized attachments when lineage patching fails", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      if (Object.values(store).some((entry) => typeof entry.spawnedBy === "string")) {
        throw new Error("lineage patch failed");
      }
      return store;
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("lineage patch failed");
    const attachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    const retainedDirs = fs.existsSync(attachmentsRoot)
      ? fs.readdirSync(attachmentsRoot).filter((entry) => !entry.startsWith("."))
      : [];
    expect(retainedDirs).toHaveLength(0);
    const deleteCall = calls.find((entry) => entry.method === "sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: expect.stringMatching(/^agent:main:subagent:/),
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });
});
