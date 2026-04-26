import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./conversation-binding.js";

let tempDir: string;

describe("codex conversation binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clears the Codex app-server sidecar when a pending bind is denied", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sidecar = `${sessionFile}.codex-app-server.json`;
    await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 1, threadId: "thread-1" }));

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    await expect(fs.stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("consumes inbound bound messages when command authorization is absent", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile: path.join(tempDir, "session.jsonl"),
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(result).toEqual({ handled: true });
  });
});
