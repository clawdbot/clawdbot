import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";

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
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
            },
          },
        },
      } as never,
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
              truncateAfterCompaction: true,
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
              truncateAfterCompaction: true,
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
              truncateAfterCompaction: true,
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

  it("ignores stale session token totals for native rollout rotation", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, {
      totalTokens: 300_000,
      totalTokensFresh: false,
    });
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
              truncateAfterCompaction: true,
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
    const readFileSpy = vi.spyOn(fs, "readFile");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(readFileSpy.mock.calls.some(([file]) => file === rolloutFile)).toBe(false);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("keeps native rollouts above the old guard when Codex still has context window headroom", async () => {
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
              total_tokens: 86_000,
            },
            model_context_window: 272_000,
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
              truncateAfterCompaction: true,
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
    const readFileSpy = vi.spyOn(fs, "readFile");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(readFileSpy.mock.calls.some(([file]) => file === rolloutFile)).toBe(false);
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
              truncateAfterCompaction: true,
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
