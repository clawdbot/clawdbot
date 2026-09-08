import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex supervised workspace adoption", () => {
  it("captures workspace notes when a pending source becomes a new OpenClaw thread", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sourceThreadId = "thread-source";
    const notes = "The synthetic workspace device is amber.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), notes);
    const params = createParams(sessionFile, workspaceDir);
    params.config = {
      ...params.config,
      agents: { defaults: { workspace: workspaceDir } },
    };
    const pluginConfig = { supervision: { enabled: true } };
    const connectionFingerprint = buildCodexAppServerConnectionFingerprint(
      resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }),
      params.agentDir,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: sourceThreadId,
      cwd: workspaceDir,
      connectionScope: "supervision",
      supervisionSourceThreadId: sourceThreadId,
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId, connectionFingerprint },
      conversationSourceTransferComplete: true,
      historyCoveredThrough: new Date(0).toISOString(),
    });
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/fork") {
          return threadStartResult("thread-probe", { cwd: workspaceDir });
        }
        if (method === "thread/start") {
          return threadStartResult("thread-canonical", { cwd: workspaceDir });
        }
        return undefined;
      },
      { persistedThreads: [sourceThreadId] },
    );

    const run = runCodexAppServerAttempt(params, { pluginConfig });
    await Promise.race([
      harness.waitForMethod("turn/start"),
      run.then((result) => {
        throw new Error("Codex attempt ended before turn/start", { cause: result });
      }),
    ]);
    await harness.completeTurn({ threadId: "thread-canonical", turnId: "turn-1" });
    expect((await run).terminal).toEqual({ kind: "ok" });

    const start = harness.requests.find((request) => request.method === "thread/start");
    expect(start?.params).toMatchObject({ developerInstructions: expect.stringContaining(notes) });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({
      threadId: "thread-canonical",
      agentWorkspaceDeveloperInstructions: expect.stringContaining(notes),
    });
    expect(binding?.pendingSupervisionBranch).toBeUndefined();
    const turn = harness.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turn?.params)).not.toContain(notes);
  });
});
