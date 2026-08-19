// Codex tests cover startup binding plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { rotateOversizedCodexAppServerStartupBinding as rotateStartupBindingImpl } from "./startup-binding.js";

function resolveCodexAppServerStartupBinding(
  params: Omit<Parameters<typeof rotateStartupBindingImpl>[0], "bindingStore" | "identity">,
) {
  return rotateStartupBindingImpl({
    ...params,
    bindingStore: testCodexAppServerBindingStore,
    identity: { kind: "session", agentId: "main", sessionId: params.sessionFile },
  });
}

async function rotateOversizedCodexAppServerStartupBinding(
  params: Omit<Parameters<typeof rotateStartupBindingImpl>[0], "bindingStore" | "identity">,
) {
  return (await resolveCodexAppServerStartupBinding(params)).binding;
}

describe("Codex app-server startup binding", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-binding-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeExistingBinding(
    sessionFile: string,
    workspaceDir: string,
    overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  ) {
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      ...overrides,
    });
  }

  async function writeSessionRecord(sessionFile: string, record: Record<string, unknown>) {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          ...(typeof record.totalTokens === "number" &&
          record.totalTokensFresh !== false &&
          !Object.hasOwn(record, "totalTokensVersion")
            ? { totalTokensFresh: true, totalTokensVersion: 1 }
            : {}),
          ...record,
        },
      }),
    );
  }

  it("does not use a default byte limit when maxActiveTranscriptBytes is unset", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      "x".repeat(2_000_000),
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("never rotates a provisional supervision source binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, {
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-existing",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: {
        sourceThreadId: "thread-existing",
        lastTurnId: "turn-terminal",
      },
    });
    await writeSessionRecord(sessionFile, { totalTokens: 999_999 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      "x".repeat(2_000_000),
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toMatchObject({
      threadId: "thread-existing",
      pendingSupervisionBranch: {
        sourceThreadId: "thread-existing",
        lastTurnId: "turn-terminal",
      },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      pendingSupervisionBranch: { sourceThreadId: "thread-existing" },
    });
  });

  it("never rotates a materialized supervised native thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, {
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    await writeSessionRecord(sessionFile, { totalTokens: 999_999 });

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      projectedTurnTokens: 999_999,
      config: {
        agents: {
          defaults: {
            compaction: { maxActiveTranscriptBytes: "1b" },
          },
        },
      } as never,
    });

    expect(binding).toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
    });
  });

  it("reuses the session record cache while sessions.json is unchanged", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const sessionsJson = path.join(path.dirname(sessionFile), "sessions.json");
    const readFileSpy = vi.spyOn(fs, "readFile");

    for (let i = 0; i < 2; i += 1) {
      const binding = await rotateOversizedCodexAppServerStartupBinding({
        binding: await readCodexAppServerBinding(sessionFile),
        sessionFile,
        agentDir,
        config: undefined,
      });
      expect(binding?.threadId).toBe("thread-existing");
    }

    const sessionStoreReads = readFileSpy.mock.calls.filter(
      ([file]) => typeof file === "string" && file === sessionsJson,
    );
    expect(sessionStoreReads).toHaveLength(1);
  });

  it("checks native rollout token pressure under default compaction config", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 241_198,
            },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("reads the latest native token snapshot from one bounded rollout tail", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      [
        JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(200_000) } }),
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 120_000 },
              model_context_window: 128_000,
            },
          },
        }),
        "",
      ].join("\n"),
    );
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
    const openFile = fs.open.bind(fs);
    const countFileReads: Array<() => number> = [];
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await openFile(file, flags, mode);
      const read = vi.spyOn(handle, "read");
      countFileReads.push(() => read.mock.calls.length);
      return handle;
    });

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    expect(countFileReads.map((count) => count())).toEqual([1]);
  });

  it("keeps rollouts above the safe root default on the bounded direct path", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    const tokenSnapshot = Buffer.from(
      `\n${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 120_000 },
            model_context_window: 128_000,
          },
        },
      })}\n`,
    );
    const oversizedOffset = 16 * 1024 * 1024 + 1;
    const rolloutHandle = await fs.open(rolloutPath, "w");
    try {
      await rolloutHandle.truncate(oversizedOffset);
      await rolloutHandle.write(tokenSnapshot, 0, tokenSnapshot.byteLength, oversizedOffset);
    } finally {
      await rolloutHandle.close();
    }
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
    const readDirectories = vi.spyOn(fs, "readdir");
    const openFile = fs.open.bind(fs);
    const countFileReads: Array<() => number> = [];
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await openFile(file, flags, mode);
      const read = vi.spyOn(handle, "read");
      countFileReads.push(() => read.mock.calls.length);
      return handle;
    });

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    expect(readDirectories).not.toHaveBeenCalled();
    expect(countFileReads.map((count) => count())).toEqual([1]);
  });

  it("scans a large trailing transcript record without repeatedly copying it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      [
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 120_000 },
              model_context_window: 128_000,
            },
          },
        }),
        JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(200_000) } }),
        "",
      ].join("\n"),
    );
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
    const concatenateBuffers = vi.spyOn(Buffer, "concat");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    const largeRecordCopies = concatenateBuffers.mock.calls.filter(
      ([fragments]) =>
        fragments.reduce((total, fragment) => total + fragment.byteLength, 0) > 65_536,
    );
    expect(largeRecordCopies).toHaveLength(1);
  });

  it("fills short filesystem reads before advancing the rollout tail cursor", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      [
        JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(80_000) } }),
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 120_000 },
              model_context_window: 128_000,
            },
          },
        }),
        "",
      ].join("\n"),
    );
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
    const openFile = fs.open.bind(fs);
    let fileReads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await openFile(file, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return (buffer: Uint8Array, offset: number, length: number, position: number) => {
              fileReads += 1;
              return target.read(buffer, offset, Math.min(length, 8_192), position);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    expect(fileReads).toBeGreaterThan(1);
  });

  it("combines the latest usage with an older context window across rollout tail chunks", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      [
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 1_000 },
              model_context_window: 128_000,
            },
          },
        }),
        JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(80_000) } }),
        JSON.stringify({
          payload: {
            type: "token_count",
            info: { last_token_usage: { total_tokens: 120_000 } },
          },
        }),
        "",
      ].join("\n"),
    );
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
  });

  it("caps the default native reserve so small context windows keep prompt budget", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 100 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 100,
            },
            model_context_window: 16_000,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("honors shorthand byte units for native rollout limits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(2_000));

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("checks the native rollout path without walking the session directories", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions", "2026", "07", "27");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(rolloutPath, "x".repeat(2_000));
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
    const readDirectories = vi.spyOn(fs, "readdir");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(readDirectories).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("never reads a stored rollout path outside Codex session roots", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const outsideDir = path.join(tempDir, "outside");
    const outsideRolloutPath = path.join(outsideDir, "rollout-thread-existing.jsonl");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(outsideRolloutPath, "x".repeat(2_000));
    await fs.writeFile(rolloutPath, "x".repeat(2_000));
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath: outsideRolloutPath });
    const stat = vi.spyOn(fs, "stat");
    const readDirectories = vi.spyOn(fs, "readdir");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(stat.mock.calls.filter(([file]) => file === outsideRolloutPath)).toHaveLength(0);
    expect(readDirectories).toHaveBeenCalled();
  });

  it("does not follow a native rollout symlink outside Codex session roots", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const outsideDir = path.join(tempDir, "outside");
    const outsideRolloutPath = path.join(outsideDir, "rollout-thread-existing.jsonl");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const symlinkPath = path.join(rolloutDir, "symlink-rollout-thread-existing.jsonl");
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(outsideRolloutPath, "x".repeat(2_000));
    await fs.writeFile(rolloutPath, "x".repeat(2_000));
    await fs.symlink(outsideRolloutPath, symlinkPath);
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath: symlinkPath });
    const readDirectories = vi.spyOn(fs, "readdir");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(readDirectories).toHaveBeenCalled();
  });

  it("does not follow a symlinked native rollout parent outside Codex session roots", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const outsideDir = path.join(tempDir, "outside");
    const outsideRolloutPath = path.join(outsideDir, "rollout-thread-existing.jsonl");
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    const redirectedDir = path.join(rolloutDir, "redirect");
    const redirectedRolloutPath = path.join(redirectedDir, "rollout-thread-existing.jsonl");
    const safeRolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(outsideRolloutPath, "x".repeat(2_000));
    await fs.writeFile(safeRolloutPath, "x".repeat(2_000));
    await fs.symlink(outsideDir, redirectedDir, "dir");
    await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath: redirectedRolloutPath });
    const readDirectories = vi.spyOn(fs, "readdir");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(readDirectories).toHaveBeenCalled();
  });

  it("honors custom Codex home rollout files for native rollout limits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(tempDir, "custom-codex-home");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(codexHome, "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(2_000));

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      codexHome,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("uses current rollout token usage before cumulative usage", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 300_000,
            },
            last_token_usage: {
              total_tokens: 12_000,
            },
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it.each([
    {
      name: "stale",
      record: { totalTokens: 300_000, totalTokensFresh: false },
    },
    {
      name: "unversioned",
      record: {
        totalTokens: 300_000,
        totalTokensFresh: true,
        totalTokensVersion: undefined,
      },
    },
  ])("ignores $name session token totals for native rollout rotation", async ({ record }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, record);
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 12_000,
            },
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("clears native rollouts at Codex's reported model context window", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.writeFile(
      rolloutFile,
      [
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                total_tokens: 128_000,
              },
            },
          },
        }),
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              model_context_window: 128_000,
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("prefers the native rollout window over a stale persisted context fallback", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000, contextTokens: 272_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 86_000,
            },
            model_context_window: 1_050_000,
          },
        },
      })}\n`,
    );

    const resolution = await resolveCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(resolution.binding?.threadId).toBe("thread-existing");
    expect(resolution.startupContextTokens).toBe(1_050_000);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("includes projected turn tokens in the native rollout pressure check", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 220_000,
            },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
      projectedTurnTokens: 30_000,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("uses the session context window when the native rollout omits its model window", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000, contextTokens: 258_400 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 241_198,
            },
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("clears byte-oversized rollouts before reading their contents", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.writeFile(rolloutFile, "x".repeat(2_000));
    const openSpy = vi.spyOn(fs, "open");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(openSpy.mock.calls.some(([file]) => String(file) === rolloutFile)).toBe(false);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("clears native rollouts at the configured byte limit", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(1_000));

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });
});
