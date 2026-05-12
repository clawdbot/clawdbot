import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import {
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
} from "./conversation-control.js";

let tempDir: string;

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

describe("codex conversation controls", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearRuntimeAuthProfileStoreSnapshots();
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

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.serviceTier).toBe("priority");
    expect(binding?.approvalPolicy).toBe("on-request");
    expect(binding?.sandbox).toBe("workspace-write");
  });

  it("does not persist public OpenAI provider after model changes on native auth bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    upsertAuthProfile({
      profileId: "work",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-1", cwd: tempDir },
        model: "gpt-5.5",
        modelProvider: "openai",
      })),
    });

    await expect(setCodexConversationModel({ sessionFile, model: "gpt-5.5" })).resolves.toBe(
      "Codex model set to gpt-5.5.",
    );

    const raw = await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8");
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(raw).not.toContain('"modelProvider": "openai"');
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("escapes model names returned from Codex before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-1", cwd: tempDir },
        model: "gpt-5.5 <@U123> [trusted](https://evil)",
        modelProvider: "openai",
      })),
    });

    await expect(setCodexConversationModel({ sessionFile, model: "gpt-5.5" })).resolves.toBe(
      "Codex model set to gpt-5.5 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09.",
    );
  });
});
