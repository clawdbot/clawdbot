import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  resolveCodexAppServerBindingPath,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
} from "./session-binding.js";

let tempDir: string;

const nativeAuthLookup: Pick<CodexAppServerAuthProfileLookup, "authProfileStore"> = {
  authProfileStore: {
    version: 1,
    profiles: {
      work: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    },
  },
};

async function writeCodexCliAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      tokens: {
        access_token: "cli-access-token",
        refresh_token: "cli-refresh-token",
        account_id: "account-cli",
      },
    })}\n`,
  );
}

describe("codex app-server session binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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
      userMcpServersFingerprint: "user-mcp-v1",
    });

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding?.schemaVersion).toBe(1);
    expect(binding?.threadId).toBe("thread-123");
    expect(binding?.sessionFile).toBe(sessionFile);
    expect(binding?.cwd).toBe(tempDir);
    expect(binding?.model).toBe("gpt-5.4-codex");
    expect(binding?.modelProvider).toBe("openai");
    expect(binding?.dynamicToolsFingerprint).toBe("tools-v1");
    expect(binding?.userMcpServersFingerprint).toBe("user-mcp-v1");
    const bindingStat = await fs.stat(resolveCodexAppServerBindingPath(sessionFile));
    expect(bindingStat.isFile()).toBe(true);
  });

  it("round-trips plugin app policy context with app ids as record keys", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    const pluginAppPolicyContext = {
      fingerprint: "plugin-policy-1",
      apps: {
        "google-calendar-app": {
          configKey: "google-calendar",
          marketplaceName: "openai-curated" as const,
          pluginName: "google-calendar",
          allowDestructiveActions: true,
          mcpServerNames: ["google-calendar"],
        },
      },
      pluginAppIds: {
        "google-calendar": ["google-calendar-app"],
      },
    };
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-123",
      cwd: tempDir,
      pluginAppPolicyContext,
    });

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("round-trips context-engine binding metadata", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-123",
      cwd: tempDir,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "lossless-policy-1",
      },
    });

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding?.contextEngine).toEqual({
      schemaVersion: 1,
      engineId: "lossless-claw",
      policyFingerprint: "lossless-policy-1",
    });
  });

  it("rejects old plugin app policy entries that duplicate the app id", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await fs.writeFile(
      resolveCodexAppServerBindingPath(sessionFile),
      `${JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        sessionFile,
        cwd: tempDir,
        pluginAppPolicyContext: {
          fingerprint: "plugin-policy-1",
          apps: {
            "google-calendar-app": {
              appId: "google-calendar-app",
              configKey: "google-calendar",
              marketplaceName: "openai-curated",
              pluginName: "google-calendar",
              allowDestructiveActions: true,
              mcpServerNames: ["google-calendar"],
            },
          },
          pluginAppIds: {
            "google-calendar": ["google-calendar-app"],
          },
        },
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      })}\n`,
    );

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding?.pluginAppPolicyContext).toBeUndefined();
  });

  it("does not persist public OpenAI as the provider for Codex-native auth bindings", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(
      sessionFile,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      nativeAuthLookup,
    );

    const raw = await fs.readFile(resolveCodexAppServerBindingPath(sessionFile), "utf8");
    const binding = await readCodexAppServerBinding(sessionFile, nativeAuthLookup);

    expect(raw).not.toContain('"modelProvider": "openai"');
    expect(binding?.threadId).toBe("thread-123");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.4-mini");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("normalizes older Codex-native bindings that stored public OpenAI provider", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await fs.writeFile(
      resolveCodexAppServerBindingPath(sessionFile),
      `${JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        sessionFile,
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      })}\n`,
    );

    const binding = await readCodexAppServerBinding(sessionFile, nativeAuthLookup);

    expect(binding?.authProfileId).toBe("work");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("normalizes legacy fast service tier bindings to Codex priority", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await fs.writeFile(
      resolveCodexAppServerBindingPath(sessionFile),
      `${JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        sessionFile,
        cwd: tempDir,
        serviceTier: "fast",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      })}\n`,
    );

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding?.serviceTier).toBe("priority");
  });

  it("does not infer native Codex auth from the profile id prefix", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(
      sessionFile,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "openai-codex:work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      {
        authProfileStore: {
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
          },
        },
      },
    );

    const binding = await readCodexAppServerBinding(sessionFile, {
      authProfileStore: {
        version: 1,
        profiles: {
          "openai-codex:work": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      },
    });

    expect(binding?.modelProvider).toBe("openai");
  });

  it("normalizes Codex CLI OAuth bindings even without a local auth profile slot", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    const codexHome = path.join(tempDir, "codex-cli");
    const agentDir = path.join(tempDir, "agent");
    vi.stubEnv("CODEX_HOME", codexHome);
    await writeCodexCliAuthFile(codexHome);

    await writeCodexAppServerBinding(
      sessionFile,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "openai-codex:default",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      { agentDir },
    );

    const raw = await fs.readFile(resolveCodexAppServerBindingPath(sessionFile), "utf8");
    const binding = await readCodexAppServerBinding(sessionFile, { agentDir });

    expect(raw).not.toContain('"modelProvider": "openai"');
    expect(binding?.authProfileId).toBe("openai-codex:default");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("clears missing bindings without throwing", async () => {
    const sessionFile = path.join(tempDir, "missing.json");
    await clearCodexAppServerBinding(sessionFile);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });
});
