import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import {
  setCodexConversationFastMode,
  setCodexConversationPermissions,
} from "./conversation-control.js";

let tempDir: string;

describe("codex conversation controls", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists fast mode and permissions for later bound turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setCodexConversationFastMode({ sessionFile, enabled: true })).resolves.toBe(
      "Codex fast mode enabled.",
    );
    await expect(setCodexConversationPermissions({ sessionFile, mode: "default" })).resolves.toBe(
      "Codex permissions set to default.",
    );

    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });
});
