/** Tests configured ACP binding thinking-default precedence. */
import { describe, expect, it } from "vitest";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import type { AgentAcpBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";

const binding: AgentAcpBinding = {
  type: "acp",
  agentId: "codex",
  match: { channel: "discord" },
};

function materializeThinking(cfg: OpenClawConfig): string | undefined {
  const factory = acpConfiguredBindingConsumer.buildTargetFactory({
    cfg,
    binding,
    channel: "discord",
    agentId: "codex",
    target: { conversationId: "convo-1" },
    bindingConversationId: "convo-1",
  });
  const materialized = factory?.materialize({
    accountId: "default",
    conversation: { conversationId: "convo-1" },
  });
  if (!materialized) {
    throw new Error("expected a configured ACP binding");
  }
  return resolveConfiguredAcpBindingSpecFromRecord(materialized.record)?.thinking;
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex", model: "ollama-cloud/glm-5.2:cloud" }],
    defaults: {
      thinkingDefault: "adaptive",
      models: {
        "ollama-cloud/glm-5.2:cloud": { params: { thinking: "off" } },
      },
    },
  },
} satisfies OpenClawConfig;

describe("acpConfiguredBindingConsumer thinking precedence", () => {
  it("honors per-model params.thinking over the global default", () => {
    expect(materializeThinking(baseCfg)).toBe("off");
  });

  it("still lets an explicit per-agent thinkingDefault win over per-model policy", () => {
    const cfg = {
      ...baseCfg,
      agents: {
        ...baseCfg.agents,
        list: [{ id: "codex", model: "ollama-cloud/glm-5.2:cloud", thinkingDefault: "high" }],
      },
    } satisfies OpenClawConfig;

    expect(materializeThinking(cfg)).toBe("high");
  });

  it("falls back to the global default when neither agent nor per-model policy is set", () => {
    const cfg = {
      ...baseCfg,
      agents: { ...baseCfg.agents, defaults: { thinkingDefault: "adaptive" } },
    } satisfies OpenClawConfig;

    expect(materializeThinking(cfg)).toBe("adaptive");
  });

  it.each([false, "disabled", "none"])("forwards per-model thinking %s as off", (thinking) => {
    expect(
      materializeThinking({
        ...baseCfg,
        agents: {
          ...baseCfg.agents,
          defaults: {
            thinkingDefault: "high",
            models: { "ollama-cloud/glm-5.2:cloud": { params: { thinking } } },
          },
        },
      }),
    ).toBe("off");
  });

  it.each([undefined, "anthropic/claude-sonnet-4-6"])(
    "leaves unconfigured thinking to the harness with model %s",
    (model) => {
      expect(materializeThinking({ agents: { list: [{ id: "codex", model }] } })).toBeUndefined();
    },
  );

  it("forwards global thinking without requiring a configured model", () => {
    expect(
      materializeThinking({
        agents: { list: [{ id: "codex" }], defaults: { thinkingDefault: "off" } },
      }),
    ).toBe("off");
  });
});
