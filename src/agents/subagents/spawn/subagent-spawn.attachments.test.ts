// Subagent spawn attachment tests cover strict base64 decoding, attachment name
// validation, materialization paths, and cleanup after spawn failures.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
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

  it.each([
    ["case-insensitive manifest alias", ".MANIFEST.JSON"],
    ["manifest trailing-dot alias", ".manifest.json."],
    ["manifest trailing-NBSP alias", ".manifest.json\u00A0"],
    ["leading-space alias", " foo.txt"],
    ["trailing-space alias", "handoff.txt "],
    ["overlong UTF-8 basename", "é".repeat(128)],
    ["Windows reserved device basename", "CON.txt"],
    ["Windows device stem with pre-extension space", "CON .txt"],
    ["Windows console input device", "CONIN$.txt"],
    ["Windows console output device", "CONOUT$.txt"],
    ["Windows clock device", "CLOCK$"],
    ["Windows clock device extension", "CLOCK$.txt"],
    ["Windows clock device spacing", "CLOCK$ .txt"],
    ["Windows clock device case", "clock$.TXT"],
    ["Windows portable forbidden character", "handoff?.txt"],
    ["lone surrogate", "\uD800"],
    ["replacement character", "\uFFFD"],
  ])("%s returns attachments_invalid_name", async (_label, name) => {
    const result = await spawnWithName(name);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it.each(["100%.txt", "wow!.txt"])("permits portable filename %s", async (name) => {
    const result = await spawnWithName(name);
    expect(result.status).toBe("accepted");
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo\nbar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const duplicateName = "sessions-spawn-duplicate.txt";
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: duplicateName, content: validContent, encoding: "base64" },
          { name: duplicateName, content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
    expect(result.error).toContain(duplicateName);
  });

  it("case-folded and normalization-equivalent names return attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "Café.txt", content: validContent, encoding: "base64" },
          { name: "cafe\u0301.TXT", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("Unicode sigma case-fold aliases return attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "Σ.txt", content: validContent, encoding: "base64" },
          { name: "ς.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("uppercase-then-NFC aliases return attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "ΐ.txt", content: validContent, encoding: "base64" },
          { name: "Ϊ́.txt", content: validContent, encoding: "base64" },
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

  it.each([
    ["non-object member", [null]],
    ["non-string content", [{ name: "file.txt", content: 42 }]],
    ["unknown encoding", [{ name: "file.txt", content: "MATERIALIZER_SECRET", encoding: "hex" }]],
    ["non-string mimeType", [{ name: "file.txt", content: "data", mimeType: 42 }]],
  ])("rejects malformed runtime attachment shape: %s", async (_label, attachments) => {
    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: attachments as never,
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_member/);
    expect(JSON.stringify(result)).not.toContain("MATERIALIZER_SECRET");
  });

  async function spawnWithForcedMaterializationFailure(params: {
    continuation: boolean;
    attachmentNames?: string[];
  }) {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const attachmentNames = params.attachmentNames ?? [
      "MATERIALIZATION_FILENAME_MUST_NOT_ECHO.txt",
    ];
    const collisionName = expectDefined(attachmentNames.at(-1), "collision attachment name");
    const randomUuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(attachmentId);
    try {
      fs.mkdirSync(
        path.join(workspaceDirOverride, ".openclaw", "attachments", attachmentId, collisionName),
        { recursive: true },
      );

      const result = await subagentSpawnModule.spawnSubagentDirect(
        {
          task: "test materialization failure redaction",
          attachments: attachmentNames.map((name) => ({ name, content: "snapshot" })),
          ...(params.continuation
            ? {
                drainsContinuationDelegateQueue: true,
                continuationChainState: {
                  count: 1,
                  startedAt: Date.now(),
                  tokens: 0,
                  chainId: "materialization-failure",
                },
              }
            : {}),
        },
        ctx,
      );
      return { result, attachmentId, attachmentNames };
    } finally {
      randomUuid.mockRestore();
    }
  }

  it("keeps ordinary materialization failures actionable without exposing paths", async () => {
    const { result, attachmentId, attachmentNames } = await spawnWithForcedMaterializationFailure({
      continuation: false,
    });

    expect(result).toEqual({
      status: "error",
      error: "attachments_materialization_failed (stage=attachment_write reason=target_conflict)",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(attachmentNames[0]);
    expect(serialized).not.toContain(attachmentId);
    expect(serialized).not.toContain(workspaceDirOverride);
  });

  it("does not leak overlapping attachment name fragments from ordinary failures", async () => {
    const overlappingFragment = "OVERLAP_FRAGMENT_MUST_NOT_ECHO";
    const secretPrefix = "SECRET_PREFIX_MUST_NOT_ECHO";
    const { result } = await spawnWithForcedMaterializationFailure({
      continuation: false,
      attachmentNames: [overlappingFragment, `${secretPrefix}-${overlappingFragment}`],
    });

    expect(result).toEqual({
      status: "error",
      error: "attachments_materialization_failed (stage=attachment_write reason=target_conflict)",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(overlappingFragment);
    expect(serialized).not.toContain(secretPrefix);
  });

  it("fully redacts continuation materialization failures", async () => {
    const { result, attachmentId, attachmentNames } = await spawnWithForcedMaterializationFailure({
      continuation: true,
    });

    expect(result).toEqual({ status: "error", error: "attachments_materialization_failed" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(attachmentNames[0]);
    expect(serialized).not.toContain(attachmentId);
    expect(serialized).not.toContain(workspaceDirOverride);
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

  it("materializes continuation delegate input in the new child workspace", async () => {
    const attachmentContent = "continuation child input";
    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "read delegated input",
        drainsContinuationDelegateQueue: true,
        continuationChainState: {
          count: 1,
          startedAt: Date.now(),
          tokens: 0,
          chainId: "attachment-chain",
        },
        attachments: [{ name: "handoff.txt", content: attachmentContent }],
        attachMountPath: "handoff",
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    const attachmentRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    const receiptDirs = fs.readdirSync(attachmentRoot);
    expect(receiptDirs).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(
          attachmentRoot,
          expectDefined(receiptDirs.at(0), "receipt directory"),
          "handoff.txt",
        ),
        "utf8",
      ),
    ).toBe(attachmentContent);
  });

  it("re-evaluates attachment policy when queued continuation input reaches spawn", async () => {
    const queuedAttachments = [{ name: "handoff.txt", content: "queued child input" }];
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: false,
            maxFiles: 50,
            maxFileBytes: 1 * 1024 * 1024,
            maxTotalBytes: 5 * 1024 * 1024,
          },
        },
      },
    });

    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "read delegated input after policy reload",
        drainsContinuationDelegateQueue: true,
        continuationChainState: {
          count: 1,
          startedAt: Date.now(),
          tokens: 0,
          chainId: "attachment-policy-change",
        },
        attachments: queuedAttachments,
      },
      ctx,
    );

    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("attachments are disabled for sessions_spawn"),
    });
    expect(fs.existsSync(path.join(workspaceDirOverride, ".openclaw", "attachments"))).toBe(false);
    expect(callGatewayMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("fails closed at child spawn if policy changes after a snapshot was accepted", async () => {
    const attachmentContent = "POLICY_CHANGED_SNAPSHOT_MUST_NOT_ECHO";
    const snapshot = [{ name: "handoff.txt", content: attachmentContent }];

    const accepted = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "accept the snapshot under the original policy",
        attachments: snapshot,
      },
      ctx,
    );
    expect(accepted.status).toBe("accepted");

    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: { sessions_spawn: { attachments: { enabled: false } } },
    });
    callGatewayMock.mockClear();

    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "materialize the previously accepted snapshot",
        attachments: snapshot,
      },
      ctx,
    );

    expect(result).toMatchObject({
      status: "forbidden",
      error:
        "attachments are disabled for sessions_spawn (enable tools.sessions_spawn.attachments.enabled)",
    });
    expect(JSON.stringify(result)).not.toContain(attachmentContent);
    // The provisional child is deliberately cleaned up after the current
    // policy rejects materialization; no child agent run begins.
    expect(
      callGatewayMock.mock.calls.filter(
        ([request]) => (request as { method?: string }).method === "agent",
      ),
    ).toHaveLength(0);
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
});
