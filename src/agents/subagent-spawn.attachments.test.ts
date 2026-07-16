// Subagent spawn attachment tests cover strict base64 decoding, attachment name
// validation, materialization paths, and cleanup after spawn failures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
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
    vi.unstubAllEnvs();
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

  it.each([
    ["empty", ""],
    ["bad padding", "abc"],
    ["invalid characters", "!@#$"],
    ["whitespace only", "   "],
    ["pre-decode oversize", "A".repeat(2737)],
    ["decoded oversize", Buffer.alloc(1025, 0x42).toString("base64")],
  ])("rejects %s base64 attachments through the spawn boundary", async (_label, content) => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: true,
            maxFiles: 50,
            maxFileBytes: 1024,
            maxTotalBytes: 5 * 1024 * 1024,
          },
        },
      },
    });
    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.bin", content, encoding: "base64" }],
      },
      ctx,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("attachments_invalid_base64_or_too_large"),
    });
  });

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

  it("materializes attachments under explicit cwd when native subagent cwd is provided", async () => {
    const explicitWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-cwd-attachments-${process.pid}-${Date.now()}-`),
    );
    try {
      const { spawnSubagentDirect } = subagentSpawnModule;
      const result = await spawnSubagentDirect(
        {
          task: "test",
          cwd: explicitWorkspaceDir,
          attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
        },
        ctx,
      );

      expect(result.status).toBe("accepted");
      const explicitAttachmentsRoot = path.join(explicitWorkspaceDir, ".openclaw", "attachments");
      const targetAttachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
      expect(fs.existsSync(explicitAttachmentsRoot)).toBe(true);
      expect(fs.existsSync(targetAttachmentsRoot)).toBe(false);
    } finally {
      fs.rmSync(explicitWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("normalizes explicit cwd before materializing native subagent attachments", async () => {
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-home-attachments-${process.pid}-${Date.now()}-`),
    );
    const expectedCwd = path.join(homeDir, "task-repo");
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      persistedStore = store;
      return store;
    });
    try {
      await withEnvAsync({ HOME: homeDir }, async () => {
        const { spawnSubagentDirect } = subagentSpawnModule;
        const result = await spawnSubagentDirect(
          {
            task: "test",
            cwd: "~/task-repo",
            attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
          },
          ctx,
        );

        expect(result.status).toBe("accepted");
        const attachmentsRoot = path.join(expectedCwd, ".openclaw", "attachments");
        expect(fs.existsSync(attachmentsRoot)).toBe(true);
        const childSessionKey = result.childSessionKey as string;
        expect(persistedStore?.[childSessionKey]?.spawnedCwd).toBe(expectedCwd);
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("removes materialized attachments when lineage patching fails", async () => {
    // Attachments are created before the child session lineage patch; failures
    // must delete both the child session and materialized files.
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
    const deleteParams = deleteCall?.params as
      | {
          key?: string;
          deleteTranscript?: boolean;
          emitLifecycleHooks?: boolean;
        }
      | undefined;
    expect(deleteParams?.key).toMatch(/^agent:main:subagent:/);
    expect(deleteParams?.deleteTranscript).toBe(true);
    expect(deleteParams?.emitLifecycleHooks).toBe(false);
  });
});
