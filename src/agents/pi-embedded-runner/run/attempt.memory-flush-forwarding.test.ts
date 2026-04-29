import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../pi-tools.types.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";

const MEMORY_RELATIVE_PATH = "memory/2026-03-24.md";

function createAttemptParams(workspaceDir: string) {
  return {
    sessionId: "session-memory-flush",
    sessionKey: "agent:main",
    sessionFile: path.join(workspaceDir, "session.json"),
    workspaceDir,
    prompt: "flush durable notes",
    timeoutMs: 30_000,
    runId: "run-memory-flush",
    provider: "openai",
    modelId: "gpt-5.4",
    model: {
      api: "responses",
      provider: "openai",
      id: "gpt-5.4",
      input: ["text"],
      contextWindow: 128_000,
    } as Model<Api>,
    authStorage: {} as AuthStorage,
    modelRegistry: {} as ModelRegistry,
    thinkLevel: "off" as const,
    trigger: "memory" as const,
    memoryFlushWritePath: MEMORY_RELATIVE_PATH,
  };
}

describe("runEmbeddedAttempt memory flush tool forwarding", () => {
  it("forwards memory trigger metadata into tool creation so append-only guards activate", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-memory-flush-"));

    try {
      expect(buildEmbeddedAttemptToolRunContext(createAttemptParams(workspaceDir))).toMatchObject({
        trigger: "memory",
        memoryFlushWritePath: MEMORY_RELATIVE_PATH,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("forwards cron job id into tool creation so self-removal can be scoped", () => {
    expect(
      buildEmbeddedAttemptToolRunContext({
        trigger: "cron",
        jobId: "job-current",
      }),
    ).toMatchObject({
      trigger: "cron",
      jobId: "job-current",
    });
  });

  it("activates the memory flush append-only write wrapper", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-memory-flush-"));
    const memoryFile = path.join(workspaceDir, MEMORY_RELATIVE_PATH);

    try {
      await fs.mkdir(path.dirname(memoryFile), { recursive: true });
      await fs.writeFile(memoryFile, "seed", "utf-8");

      const { wrapToolMemoryFlushAppendOnlyWrite } = await import("../../pi-tools.read.js");
      const fallbackWrite = vi.fn(async () => {
        throw new Error("append-only wrapper should not delegate to the base write tool");
      });
      const writeTool: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "Write content to a file.",
        parameters: { type: "object", properties: {} },
        execute: fallbackWrite,
      };
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
        root: workspaceDir,
        relativePath: MEMORY_RELATIVE_PATH,
      });

      await expect(
        wrapped.execute("call-memory-flush-append", {
          path: MEMORY_RELATIVE_PATH,
          content: "new durable note",
        }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: `Appended content to ${MEMORY_RELATIVE_PATH}.` }],
        details: {
          path: MEMORY_RELATIVE_PATH,
          appendOnly: true,
        },
      });
      await expect(fs.readFile(memoryFile, "utf-8")).resolves.toBe("seed\nnew durable note");
      await expect(
        wrapped.execute("call-memory-flush-deny", {
          path: "memory/other-day.md",
          content: "wrong target",
        }),
      ).rejects.toThrow(
        `Memory flush writes are restricted to ${MEMORY_RELATIVE_PATH}; use that path only.`,
      );
      expect(fallbackWrite).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
