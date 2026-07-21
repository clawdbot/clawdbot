import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";

describe("resolveConversationCapabilityProfile", () => {
  it("prepares a direct conversation profile with sender tool restrictions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "id:guest": { deny: ["exec", "process"] },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "main",
      messageProvider: "discord",
      chatType: "direct",
      senderId: "guest",
      modelProvider: "openai",
      modelId: "gpt-5.5",
      modelApi: "responses",
      workspaceDir: "/tmp/openclaw-direct-profile",
      cwd: "/tmp/openclaw-direct-profile/task",
      agentDir: "/tmp/openclaw-agent-direct-profile",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "ops" }],
      },
    });

    expect(profile.conversation.scope).toBe("direct");
    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
    expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
    expect(profile.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "responses",
    });
    expect(profile.workspace).toMatchObject({
      workspaceRoot: "/tmp/openclaw-direct-profile",
      runtimeRoot: "/tmp/openclaw-direct-profile/task",
      instructionRoot: "/tmp/openclaw-agent-direct-profile",
    });
    expect(profile.skills.snapshot?.skills).toEqual([{ name: "ops" }]);
  });

  it("exempts owner WebChat from wildcard sender tool restrictions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "*": { deny: ["exec", "process"] },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      chatType: "direct",
      senderIsOwner: true,
    });

    expect(profile.policy.senderPolicy).toBeUndefined();
    expect(profile.policy.explicitToolDenylist).toEqual([]);
  });

  it("exempts owner WebChat identified through the message channel", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "*": { deny: ["exec", "process"] },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      messageChannel: INTERNAL_MESSAGE_CHANNEL,
      chatType: "direct",
      senderIsOwner: true,
    });

    expect(profile.policy.senderPolicy).toBeUndefined();
    expect(profile.policy.explicitToolDenylist).toEqual([]);
  });

  it("keeps wildcard sender tool restrictions for non-owner WebChat", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "*": { deny: ["exec", "process"] },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      chatType: "direct",
      senderIsOwner: false,
    });

    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
    expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
  });

  it("keeps wildcard sender tool restrictions for owners on external channels", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "*": { deny: ["exec", "process"] },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      messageProvider: "discord",
      chatType: "direct",
      senderIsOwner: true,
    });

    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
    expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
  });

  it("prepares a shared conversation profile with group per-sender restrictions", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            team: {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:alice": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:team",
      agentId: "main",
      messageProvider: "whatsapp",
      chatType: "group",
      groupId: "team",
      senderId: "alice",
      modelProvider: "openai",
      modelId: "gpt-5.5",
      workspaceDir: "/tmp/openclaw-shared-profile",
    });

    expect(profile.conversation.scope).toBe("shared");
    expect(profile.policy.trustedGroup).toEqual({ groupId: "team", dropped: false });
    expect(profile.policy.groupPolicy).toEqual({ allow: ["read", "exec"] });
    expect(profile.policy.explicitToolAllowlist).toEqual(["read", "exec"]);
  });

  it("keeps built-in profile grants out of explicit overrides", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        tools: {
          profile: "coding",
          allow: ["pdf"],
        },
      },
      modelProvider: "ollama",
      modelId: "qwen3.5:9b",
    });

    expect(profile.policy.explicitToolAllowlist).toContain("image_generate");
    expect(profile.policy.explicitToolOverrideAllowlist).toEqual(["pdf"]);
  });

  it("adds runtime tools without replacing the configured tool surface", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        tools: {
          profile: "coding",
          deny: ["workboard_block"],
        },
      },
      runtimePluginToolGrant: {
        pluginId: "workboard",
        toolNames: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
      },
    });

    expect(profile.policy.profileAlsoAllow).toEqual(["workboard_heartbeat", "workboard_complete"]);
    expect(profile.policy.providerProfileAlsoAllow).toEqual([
      "workboard_heartbeat",
      "workboard_complete",
    ]);
    expect(profile.policy.explicitToolAllowlist).toEqual(expect.arrayContaining(["read", "exec"]));
    expect(profile.policy.explicitToolAllowlist).not.toContain("workboard_heartbeat");
    expect(profile.policy.explicitToolOverrideAllowlist).toEqual([]);
    expect(profile.policy.explicitToolDenylist).toEqual(["workboard_block"]);
    expect(profile.policy.runtimePluginToolGrant).toEqual({
      pluginId: "workboard",
      toolNames: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
    });
    expect(profile.policy.inheritancePolicies).not.toContainEqual({
      allow: ["workboard_heartbeat", "workboard_complete"],
    });
  });

  it("keeps inherited subagent grants out of explicit overrides", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capability-profile-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:subagent:limited";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "limited-session",
      updatedAt: Date.now(),
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      spawnedBy: "agent:main:main",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["image_generate"],
    } as SessionEntry);

    try {
      const profile = resolveConversationCapabilityProfile({
        config: { session: { store: storePath } },
        sessionKey,
        agentId: "main",
        modelProvider: "ollama",
        modelId: "qwen3.5:9b",
      });

      expect(profile.policy.explicitToolAllowlist).toContain("image_generate");
      expect(profile.policy.explicitToolOverrideAllowlist).not.toContain("image_generate");
      expect(profile.policy.delegated).toBe(true);
      expect(profile.policy.requesterPolicySource).toBe("persisted-child");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps runtime allowlists local unless the caller opts into inheritance", () => {
    const localRuntimeProfile = resolveConversationCapabilityProfile({
      runtimeToolAllowlist: ["sessions_spawn", "memory_search"],
    });

    expect(localRuntimeProfile.policy.explicitToolAllowlist).toEqual([
      "sessions_spawn",
      "memory_search",
    ]);
    expect(localRuntimeProfile.policy.explicitToolOverrideAllowlist).toEqual([
      "sessions_spawn",
      "memory_search",
    ]);
    expect(localRuntimeProfile.policy.runtimeToolPolicyForInheritance).toBeUndefined();

    const inheritedRuntimeProfile = resolveConversationCapabilityProfile({
      runtimeToolAllowlist: ["sessions_spawn", "memory_search"],
      inheritRuntimeToolAllowlist: true,
    });

    expect(inheritedRuntimeProfile.policy.runtimeToolPolicyForInheritance).toEqual({
      allow: ["sessions_spawn", "memory_search"],
    });
    expect(inheritedRuntimeProfile.policy.inheritancePolicies).toContain(
      inheritedRuntimeProfile.policy.runtimeToolPolicyForInheritance,
    );
  });

  it("does not classify the conversation as shared from a dropped caller group id", () => {
    // Non-group session key cannot vouch for the caller-supplied group facts:
    // the trust check drops them, so scope must stay unknown instead of
    // reflecting untrusted input that the profile itself publishes as null.
    const profile = resolveConversationCapabilityProfile({
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "main",
      messageProvider: "discord",
      groupId: "team",
      groupChannel: "#general",
      groupSpace: "guild-1",
      senderId: "guest",
    });

    expect(profile.policy.trustedGroup).toEqual({ groupId: null, dropped: true });
    expect(profile.conversation.groupId).toBeNull();
    expect(profile.conversation.groupChannel).toBeNull();
    expect(profile.conversation.groupSpace).toBeNull();
    expect(profile.conversation.scope).toBe("unknown");
  });

  it("classifies group-scoped session keys as shared without a live chat type", () => {
    const profile = resolveConversationCapabilityProfile({
      sessionKey: "agent:main:whatsapp:group:team",
      agentId: "main",
      messageProvider: "whatsapp",
    });

    expect(profile.conversation.scope).toBe("shared");
  });

  it("classifies shared scope from the live run session key behind a sandbox policy key", () => {
    const profile = resolveConversationCapabilityProfile({
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:telegram:group:ops",
      agentId: "main",
      messageProvider: "telegram",
    });

    expect(profile.conversation.scope).toBe("shared");
  });

  it("keeps trusted caller group facts shared when the session key vouches for them", () => {
    const profile = resolveConversationCapabilityProfile({
      sessionKey: "agent:main:whatsapp:group:team",
      agentId: "main",
      messageProvider: "whatsapp",
      groupId: "team",
    });

    expect(profile.policy.trustedGroup).toEqual({ groupId: "team", dropped: false });
    expect(profile.conversation.scope).toBe("shared");
  });
});
