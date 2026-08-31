// Whatsapp tests cover configured ACP binding support.
import { resolveConfiguredAcpBindingRecord } from "openclaw/plugin-sdk/acp-binding-resolve-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

function createCfg(
  peerId: string,
  accountId = "work",
  peerKind: "direct" | "group" = "direct",
): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "sandboxed-agent",
          runtime: {
            type: "acp",
            acp: {
              agent: "codex",
              backend: "acpx",
              cwd: "/workspace/sandboxed-agent",
              mode: "oneshot",
            },
          },
        },
      ],
    },
    bindings: [
      {
        type: "acp",
        agentId: "sandboxed-agent",
        match: {
          channel: "whatsapp",
          accountId,
          peer: {
            kind: peerKind,
            id: peerId,
          },
        },
      },
    ],
  } as OpenClawConfig;
}

describe("WhatsApp configured ACP bindings", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: whatsappPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("materializes direct WhatsApp ACP bindings from inbound JIDs", () => {
    const resolved = resolveConfiguredAcpBindingRecord({
      cfg: createCfg("+15551234567"),
      channel: "whatsapp",
      accountId: "work",
      conversationId: "15551234567@s.whatsapp.net",
    });

    expect(resolved?.spec.channel).toBe("whatsapp");
    expect(resolved?.spec.accountId).toBe("work");
    expect(resolved?.spec.conversationId).toBe("+15551234567");
    expect(resolved?.spec.agentId).toBe("sandboxed-agent");
    expect(resolved?.spec.mode).toBe("oneshot");
    expect(resolved?.spec.backend).toBe("acpx");
    expect(resolved?.record.conversation.conversationId).toBe("+15551234567");
    expect(resolved?.record.targetSessionKey).toContain(
      "agent:sandboxed-agent:acp:binding:whatsapp:work:",
    );
  });

  it("normalizes WhatsApp group JIDs for configured ACP binding lookup", () => {
    const resolved = resolveConfiguredAcpBindingRecord({
      cfg: createCfg("120363001234567890@g.us", "work", "group"),
      channel: "whatsapp",
      accountId: "work",
      conversationId: "whatsapp:group:120363001234567890@g.us",
    });

    expect(resolved?.spec.conversationId).toBe("120363001234567890@g.us");
    expect(resolved?.record.conversation.conversationId).toBe("120363001234567890@g.us");
    expect(resolved?.record.targetSessionKey).toContain(
      "agent:sandboxed-agent:acp:binding:whatsapp:work:",
    );
  });
});
