import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-model", {
        modelProvider: "qwencode",
        model: "qwen3.5-plus-2026-02-15",
        contextTokens: 123456,
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      sessionFile?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-model");
  const sessionFile = reset.payload?.entry.sessionFile;
  if (!sessionFile) {
    throw new Error("expected reset session file");
  }
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(reset.payload?.entry.contextTokens).toBeUndefined();
  expect((await fs.stat(sessionFile)).isFile()).toBe(true);
});

test("sessions.reset drops cached skills snapshot so /new rebuilds visible skills", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-skills", {
        skillsSnapshot: {
          prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
          skills: [{ name: "stale" }],
          version: 0,
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      skillsSnapshot?: unknown;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-skills");
  expect(reset.payload?.entry.skillsSnapshot).toBeUndefined();

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { skillsSnapshot?: unknown }
  >;
  expect(store["agent:main:main"]?.skillsSnapshot).toBeUndefined();
});

test("sessions.reset preserves legacy explicit model overrides without modelOverrideSource", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-explicit-model-override", {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelProvider: "openai",
        model: "gpt-test-a",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      modelProvider?: string;
      model?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.providerOverride).toBe("anthropic");
  expect(reset.payload?.entry.modelOverride).toBe("claude-opus-4-1");
  expect(reset.payload?.entry.modelOverrideSource).toBe("user");
  expect(reset.payload?.entry.modelProvider).toBe("anthropic");
  expect(reset.payload?.entry.model).toBe("claude-opus-4-1");

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      modelProvider?: string;
      model?: string;
    }
  >;
  expect(store["agent:main:main"]?.providerOverride).toBe("anthropic");
  expect(store["agent:main:main"]?.modelOverride).toBe("claude-opus-4-1");
  expect(store["agent:main:main"]?.modelOverrideSource).toBe("user");
  expect(store["agent:main:main"]?.modelProvider).toBe("anthropic");
  expect(store["agent:main:main"]?.model).toBe("claude-opus-4-1");
});

test("sessions.reset clears fallback-pinned model overrides and restores the selected model", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-fallback-model-override", {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelOverrideSource: "auto",
        fallbackNoticeSelectedModel: "openai/gpt-test-a",
        fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
        fallbackNoticeReason: "rate limit",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      providerOverride?: string;
      modelOverride?: string;
      modelProvider?: string;
      model?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.providerOverride).toBeUndefined();
  expect(reset.payload?.entry.modelOverride).toBeUndefined();
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      providerOverride?: string;
      modelOverride?: string;
      modelProvider?: string;
      model?: string;
    }
  >;
  expect(store["agent:main:main"]?.providerOverride).toBeUndefined();
  expect(store["agent:main:main"]?.modelOverride).toBeUndefined();
  expect(store["agent:main:main"]?.modelProvider).toBe("openai");
  expect(store["agent:main:main"]?.model).toBe("gpt-test-a");
});

test("sessions.reset follows the updated default after an auto fallback pinned an older default", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-c",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-fallback-stale-default", {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelOverrideSource: "auto",
        fallbackNoticeSelectedModel: "openai/gpt-test-a",
        fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
        fallbackNoticeReason: "rate limit",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      providerOverride?: string;
      modelOverride?: string;
      modelProvider?: string;
      model?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.providerOverride).toBeUndefined();
  expect(reset.payload?.entry.modelOverride).toBeUndefined();
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-c");

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      providerOverride?: string;
      modelOverride?: string;
      modelProvider?: string;
      model?: string;
    }
  >;
  expect(store["agent:main:main"]?.providerOverride).toBeUndefined();
  expect(store["agent:main:main"]?.modelOverride).toBeUndefined();
  expect(store["agent:main:main"]?.modelProvider).toBe("openai");
  expect(store["agent:main:main"]?.model).toBe("gpt-test-c");
});

test("sessions.reset preserves spawned session ownership metadata", async () => {
  const { storePath } = await createSessionStoreDir();
  const customSessionFile = path.join(
    await fs.realpath(path.dirname(storePath)),
    "custom-owned-child-transcript.jsonl",
  );
  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-owned-child", {
        sessionFile: customSessionFile,
        chatType: "group",
        channel: "discord",
        groupId: "group-1",
        subject: "Ops Thread",
        groupChannel: "dev",
        space: "hq",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        parentSessionKey: "agent:main:main",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        elevatedLevel: "on",
        ttsAuto: "always",
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelOverrideSource: "user",
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 7,
        sendPolicy: "deny",
        queueMode: "interrupt",
        queueDebounceMs: 250,
        queueCap: 9,
        queueDrop: "old",
        groupActivation: "always",
        groupActivationNeedsSystemIntro: true,
        execHost: "gateway",
        execSecurity: "allowlist",
        execAsk: "on-miss",
        execNode: "mac-mini",
        displayName: "Ops Child",
        cliSessionIds: {
          "claude-cli": "cli-session-123",
        },
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "cli-session-123",
            authProfileId: "anthropic:work",
            extraSystemPromptHash: "prompt-hash",
          },
        },
        claudeCliSessionId: "cli-session-123",
        deliveryContext: {
          channel: "discord",
          to: "discord:child",
          accountId: "acct-1",
          threadId: "thread-1",
        },
        label: "owned child",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionFile?: string;
      chatType?: string;
      channel?: string;
      groupId?: string;
      subject?: string;
      groupChannel?: string;
      space?: string;
      spawnedBy?: string;
      spawnedWorkspaceDir?: string;
      parentSessionKey?: string;
      forkedFromParent?: boolean;
      spawnDepth?: number;
      subagentRole?: string;
      subagentControlScope?: string;
      elevatedLevel?: string;
      ttsAuto?: string;
      providerOverride?: string;
      modelOverride?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      authProfileOverrideCompactionCount?: number;
      sendPolicy?: string;
      queueMode?: string;
      queueDebounceMs?: number;
      queueCap?: number;
      queueDrop?: string;
      groupActivation?: string;
      groupActivationNeedsSystemIntro?: boolean;
      execHost?: string;
      execSecurity?: string;
      execAsk?: string;
      execNode?: string;
      displayName?: string;
      cliSessionBindings?: Record<
        string,
        {
          sessionId?: string;
          authProfileId?: string;
          extraSystemPromptHash?: string;
          mcpConfigHash?: string;
        }
      >;
      cliSessionIds?: Record<string, string>;
      claudeCliSessionId?: string;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string;
      };
      label?: string;
    };
  }>("sessions.reset", { key: "subagent:child" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionFile).toBe(customSessionFile);
  expect(reset.payload?.entry.chatType).toBe("group");
  expect(reset.payload?.entry.channel).toBe("discord");
  expect(reset.payload?.entry.groupId).toBe("group-1");
  expect(reset.payload?.entry.subject).toBe("Ops Thread");
  expect(reset.payload?.entry.groupChannel).toBe("dev");
  expect(reset.payload?.entry.space).toBe("hq");
  expect(reset.payload?.entry.spawnedBy).toBe("agent:main:main");
  expect(reset.payload?.entry.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
  expect(reset.payload?.entry.parentSessionKey).toBe("agent:main:main");
  expect(reset.payload?.entry.forkedFromParent).toBe(true);
  expect(reset.payload?.entry.spawnDepth).toBe(2);
  expect(reset.payload?.entry.subagentRole).toBe("orchestrator");
  expect(reset.payload?.entry.subagentControlScope).toBe("children");
  expect(reset.payload?.entry.elevatedLevel).toBe("on");
  expect(reset.payload?.entry.ttsAuto).toBe("always");
  expect(reset.payload?.entry.providerOverride).toBe("anthropic");
  expect(reset.payload?.entry.modelOverride).toBe("claude-opus-4-1");
  expect(reset.payload?.entry.authProfileOverride).toBe("work");
  expect(reset.payload?.entry.authProfileOverrideSource).toBe("user");
  expect(reset.payload?.entry.authProfileOverrideCompactionCount).toBe(7);
  expect(reset.payload?.entry.sendPolicy).toBe("deny");
  expect(reset.payload?.entry.queueMode).toBe("interrupt");
  expect(reset.payload?.entry.queueDebounceMs).toBe(250);
  expect(reset.payload?.entry.queueCap).toBe(9);
  expect(reset.payload?.entry.queueDrop).toBe("old");
  expect(reset.payload?.entry.groupActivation).toBe("always");
  expect(reset.payload?.entry.groupActivationNeedsSystemIntro).toBe(true);
  expect(reset.payload?.entry.execHost).toBe("gateway");
  expect(reset.payload?.entry.execSecurity).toBe("allowlist");
  expect(reset.payload?.entry.execAsk).toBe("on-miss");
  expect(reset.payload?.entry.execNode).toBe("mac-mini");
  expect(reset.payload?.entry.displayName).toBe("Ops Child");
  expect(reset.payload?.entry.cliSessionBindings).toEqual({
    "claude-cli": {
      sessionId: "cli-session-123",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
    },
  });
  expect(reset.payload?.entry.cliSessionIds).toEqual({
    "claude-cli": "cli-session-123",
  });
  expect(reset.payload?.entry.claudeCliSessionId).toBe("cli-session-123");
  expect(reset.payload?.entry.deliveryContext).toEqual({
    channel: "discord",
    to: "discord:child",
    accountId: "acct-1",
    threadId: "thread-1",
  });
  expect(reset.payload?.entry.label).toBe("owned child");

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      sessionFile?: string;
      chatType?: string;
      channel?: string;
      groupId?: string;
      subject?: string;
      groupChannel?: string;
      space?: string;
      spawnedBy?: string;
      spawnedWorkspaceDir?: string;
      parentSessionKey?: string;
      forkedFromParent?: boolean;
      spawnDepth?: number;
      subagentRole?: string;
      subagentControlScope?: string;
      elevatedLevel?: string;
      ttsAuto?: string;
      providerOverride?: string;
      modelOverride?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      authProfileOverrideCompactionCount?: number;
      sendPolicy?: string;
      queueMode?: string;
      queueDebounceMs?: number;
      queueCap?: number;
      queueDrop?: string;
      groupActivation?: string;
      groupActivationNeedsSystemIntro?: boolean;
      execHost?: string;
      execSecurity?: string;
      execAsk?: string;
      execNode?: string;
      displayName?: string;
      cliSessionBindings?: Record<
        string,
        {
          sessionId?: string;
          authProfileId?: string;
          extraSystemPromptHash?: string;
          mcpConfigHash?: string;
        }
      >;
      cliSessionIds?: Record<string, string>;
      claudeCliSessionId?: string;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string;
      };
      label?: string;
    }
  >;
  expect(store["agent:main:subagent:child"]?.sessionFile).toBe(customSessionFile);
  expect(store["agent:main:subagent:child"]?.chatType).toBe("group");
  expect(store["agent:main:subagent:child"]?.channel).toBe("discord");
  expect(store["agent:main:subagent:child"]?.groupId).toBe("group-1");
  expect(store["agent:main:subagent:child"]?.subject).toBe("Ops Thread");
  expect(store["agent:main:subagent:child"]?.groupChannel).toBe("dev");
  expect(store["agent:main:subagent:child"]?.space).toBe("hq");
  expect(store["agent:main:subagent:child"]?.spawnedBy).toBe("agent:main:main");
  expect(store["agent:main:subagent:child"]?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
  expect(store["agent:main:subagent:child"]?.parentSessionKey).toBe("agent:main:main");
  expect(store["agent:main:subagent:child"]?.forkedFromParent).toBe(true);
  expect(store["agent:main:subagent:child"]?.spawnDepth).toBe(2);
  expect(store["agent:main:subagent:child"]?.subagentRole).toBe("orchestrator");
  expect(store["agent:main:subagent:child"]?.subagentControlScope).toBe("children");
  expect(store["agent:main:subagent:child"]?.elevatedLevel).toBe("on");
  expect(store["agent:main:subagent:child"]?.ttsAuto).toBe("always");
  expect(store["agent:main:subagent:child"]?.providerOverride).toBe("anthropic");
  expect(store["agent:main:subagent:child"]?.modelOverride).toBe("claude-opus-4-1");
  expect(store["agent:main:subagent:child"]?.authProfileOverride).toBe("work");
  expect(store["agent:main:subagent:child"]?.authProfileOverrideSource).toBe("user");
  expect(store["agent:main:subagent:child"]?.authProfileOverrideCompactionCount).toBe(7);
  expect(store["agent:main:subagent:child"]?.sendPolicy).toBe("deny");
  expect(store["agent:main:subagent:child"]?.queueMode).toBe("interrupt");
  expect(store["agent:main:subagent:child"]?.queueDebounceMs).toBe(250);
  expect(store["agent:main:subagent:child"]?.queueCap).toBe(9);
  expect(store["agent:main:subagent:child"]?.queueDrop).toBe("old");
  expect(store["agent:main:subagent:child"]?.groupActivation).toBe("always");
  expect(store["agent:main:subagent:child"]?.groupActivationNeedsSystemIntro).toBe(true);
  expect(store["agent:main:subagent:child"]?.execHost).toBe("gateway");
  expect(store["agent:main:subagent:child"]?.execSecurity).toBe("allowlist");
  expect(store["agent:main:subagent:child"]?.execAsk).toBe("on-miss");
  expect(store["agent:main:subagent:child"]?.execNode).toBe("mac-mini");
  expect(store["agent:main:subagent:child"]?.displayName).toBe("Ops Child");
  expect(store["agent:main:subagent:child"]?.cliSessionBindings).toEqual({
    "claude-cli": {
      sessionId: "cli-session-123",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
    },
  });
  expect(store["agent:main:subagent:child"]?.cliSessionIds).toEqual({
    "claude-cli": "cli-session-123",
  });
  expect(store["agent:main:subagent:child"]?.claudeCliSessionId).toBe("cli-session-123");
  expect(store["agent:main:subagent:child"]?.deliveryContext).toEqual({
    channel: "discord",
    to: "discord:child",
    accountId: "acct-1",
    threadId: "thread-1",
  });
  expect(store["agent:main:subagent:child"]?.label).toBe("owned child");
});
