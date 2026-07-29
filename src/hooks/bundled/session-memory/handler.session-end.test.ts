import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import {
  clearInternalHooks,
  getRegisteredEventKeys,
  registerInternalHook,
} from "../../internal-hooks.js";
import { loadInternalHooks } from "../../loader.js";
import { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs: string[] = [];

async function createTempDir(reason: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-session-end-${reason}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  clearInternalHooks();
  await flushSessionMemoryWritesForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-memory typed session_end lifecycle", () => {
  it.each(["new", "reset", "daily", "idle"] as const)(
    "writes the real memory artifact for reason %s",
    async (reason) => {
      const tempDir = await createTempDir(reason);
      const storePath = path.join(tempDir, "sessions.json");
      const sessionId = `${reason}-session`;
      const sessionKey = "agent:main:main";
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        hooks: {
          internal: {
            enabled: true,
            entries: { "session-memory": { enabled: true } },
          },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;

      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: { role: "user", content: `Remember the ${reason} boundary` },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured from the lifecycle event" },
        },
      ]);

      await expect(loadInternalHooks(cfg, tempDir)).resolves.toBeGreaterThan(0);
      expect(getRegisteredEventKeys()).toContain("session:end");
      const runner = createHookRunner(createMockPluginRegistry([]));
      expect(runner.hasHooks("session_end")).toBe(true);

      await runner.runSessionEnd(
        {
          sessionId,
          sessionKey,
          messageCount: 2,
          reason,
          sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
        },
        { agentId: "main", sessionId, sessionKey },
        { config: cfg },
      );
      await flushSessionMemoryWritesForTest();

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      expect(files).toHaveLength(1);
      const memoryContent = await fs.readFile(path.join(memoryDir, files[0]!), "utf8");
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: Remember the ${reason} boundary`);
      expect(memoryContent).toContain("assistant: Captured from the lifecycle event");
    },
  );

  it("ignores non-rollover session endings", async () => {
    const tempDir = await createTempDir("shutdown");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          enabled: true,
          entries: { "session-memory": { enabled: true } },
        },
      },
    } satisfies OpenClawConfig;

    await expect(loadInternalHooks(cfg, tempDir)).resolves.toBeGreaterThan(0);
    expect(getRegisteredEventKeys()).toContain("session:end");
    const listener = vi.fn();
    registerInternalHook("session:end", listener);
    const runner = createHookRunner(createMockPluginRegistry([]));

    await runner.runSessionEnd(
      {
        sessionId: "shutdown-session",
        sessionKey: "agent:main:main",
        messageCount: 0,
        reason: "shutdown",
      },
      { agentId: "main", sessionId: "shutdown-session", sessionKey: "agent:main:main" },
      { config: cfg },
    );
    await flushSessionMemoryWritesForTest();

    expect(listener).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tempDir, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives the agent workspace from the session key", async () => {
    const tempDir = await createTempDir("agent-workspace");
    const mainWorkspace = path.join(tempDir, "main");
    const naviWorkspace = path.join(tempDir, "navi");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "navi-session";
    const sessionKey = "agent:navi:main";
    const cfg = {
      agents: {
        defaults: { workspace: mainWorkspace },
        list: [{ id: "navi", workspace: naviWorkspace }],
      },
      hooks: {
        internal: {
          enabled: true,
          entries: { "session-memory": { enabled: true } },
        },
      },
      session: { store: storePath },
    } satisfies OpenClawConfig;

    await replaceTranscriptEvents({ agentId: "navi", sessionId, sessionKey, storePath }, [
      {
        type: "message",
        id: "navi-user",
        parentId: null,
        message: { role: "user", content: "Keep this in Navi's workspace" },
      },
    ]);
    await loadInternalHooks(cfg, mainWorkspace);
    const runner = createHookRunner(createMockPluginRegistry([]));

    await runner.runSessionEnd(
      { sessionId, sessionKey, messageCount: 1, reason: "daily" },
      { sessionId },
      { config: cfg },
    );
    await flushSessionMemoryWritesForTest();

    const files = await fs.readdir(path.join(naviWorkspace, "memory"));
    expect(files).toHaveLength(1);
    await expect(fs.access(path.join(mainWorkspace, "memory"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves lifecycle workspace and store overrides", async () => {
    const tempDir = await createTempDir("runtime-overrides");
    const defaultWorkspace = path.join(tempDir, "default");
    const runtimeWorkspace = path.join(tempDir, "runtime");
    const runtimeStorePath = path.join(tempDir, "runtime-sessions.json");
    const sessionId = "runtime-session";
    const sessionKey = "agent:main:main";
    const cfg = {
      agents: { defaults: { workspace: defaultWorkspace } },
      hooks: {
        internal: {
          enabled: true,
          entries: { "session-memory": { enabled: true } },
        },
      },
      session: { store: path.join(tempDir, "configured-sessions.json") },
    } satisfies OpenClawConfig;

    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey, storePath: runtimeStorePath },
      [
        {
          type: "message",
          id: "runtime-user",
          parentId: null,
          message: { role: "user", content: "Keep the runtime-owned transcript" },
        },
      ],
    );
    await loadInternalHooks(cfg, defaultWorkspace);
    const runner = createHookRunner(createMockPluginRegistry([]));

    await runner.runSessionEnd(
      { sessionId, sessionKey, messageCount: 1, reason: "idle" },
      { agentId: "main", sessionId, sessionKey },
      {
        config: cfg,
        agentId: "main",
        workspaceDir: runtimeWorkspace,
        storePath: runtimeStorePath,
      },
    );
    await flushSessionMemoryWritesForTest();

    const files = await fs.readdir(path.join(runtimeWorkspace, "memory"));
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(runtimeWorkspace, "memory", files[0]!), "utf8");
    expect(content).toContain("user: Keep the runtime-owned transcript");
    await expect(fs.access(path.join(defaultWorkspace, "memory"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not block typed lifecycle completion on internal hooks", async () => {
    const tempDir = await createTempDir("nonblocking");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          enabled: true,
          entries: { "session-memory": { enabled: true } },
        },
      },
    } satisfies OpenClawConfig;
    await loadInternalHooks(cfg, tempDir);

    let release: (() => void) | undefined;
    let started = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerInternalHook("session", async () => {
      started = true;
      await blocked;
    });
    const runner = createHookRunner(createMockPluginRegistry([]));

    await runner.runSessionEnd(
      {
        sessionId: "nonblocking-session",
        sessionKey: "agent:main:main",
        messageCount: 0,
        reason: "daily",
      },
      { sessionId: "nonblocking-session", sessionKey: "agent:main:main" },
      { config: cfg },
    );

    expect(started).toBe(true);
    release?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await flushSessionMemoryWritesForTest();
  });

  it("ignores lifecycle events without a session key", async () => {
    const tempDir = await createTempDir("missing-key");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          enabled: true,
          entries: { "session-memory": { enabled: true } },
        },
      },
    } satisfies OpenClawConfig;
    await loadInternalHooks(cfg, tempDir);
    const runner = createHookRunner(createMockPluginRegistry([]));

    await runner.runSessionEnd(
      { sessionId: "missing-key-session", messageCount: 0, reason: "daily" },
      { sessionId: "missing-key-session" },
      { config: cfg },
    );
    await flushSessionMemoryWritesForTest();

    await expect(fs.access(path.join(tempDir, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
