// Codex tests cover startup binding rotation for policy-restricted threads.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { rotateOversizedCodexAppServerStartupBinding as rotateStartupBindingImpl } from "./startup-binding.js";

async function rotateOversizedCodexAppServerStartupBinding(
  params: Omit<Parameters<typeof rotateStartupBindingImpl>[0], "bindingStore" | "identity">,
) {
  return (
    await rotateStartupBindingImpl({
      ...params,
      bindingStore: testCodexAppServerBindingStore,
      identity: { kind: "session", agentId: "main", sessionId: params.sessionFile },
    })
  ).binding;
}

describe("Codex app-server startup binding rotation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-rotation-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rotates an oversized restricted binding so an ordinary turn proceeds fresh", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    // Host-isolated or policy-restricted bindings refuse native compaction by design;
    // their byte-fuse recovery is a fresh thread, not a compact request.
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      nativeToolPolicyRestricted: true,
    });
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
            compaction: { maxActiveTranscriptBytes: "1b" },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBeUndefined();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });
});
