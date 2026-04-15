import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  resolveCodexAppServerBindingPath,
  writeCodexAppServerBinding,
} from "./session-binding.js";

let tempDir: string;

describe("codex app-server session binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips the thread binding beside the PI session file", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-123",
      cwd: tempDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "tools-v1",
    });

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding).toMatchObject({
      schemaVersion: 1,
      threadId: "thread-123",
      sessionFile,
      cwd: tempDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "tools-v1",
    });
    await expect(fs.stat(resolveCodexAppServerBindingPath(sessionFile))).resolves.toBeTruthy();
  });

  it("clears missing bindings without throwing", async () => {
    const sessionFile = path.join(tempDir, "missing.json");
    await clearCodexAppServerBinding(sessionFile);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });
});
