import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

export function buildSubagentRun(): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:abc",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "do thing",
    cleanup: "keep",
    createdAt: 1000,
    startedAt: 1000,
  };
}

export function buildSubagentsSendContext(params?: {
  cfg?: OpenClawConfig;
  handledPrefix?: string;
  requesterKey?: string;
  runs?: SubagentRunRecord[];
  restTokens?: string[];
}) {
  return {
    params: {
      cfg:
        params?.cfg ??
        ({
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
      ctx: {},
      command: {
        channel: "whatsapp",
        to: "test-bot",
      },
    },
    handledPrefix: params?.handledPrefix ?? "/subagents",
    requesterKey: params?.requesterKey ?? "agent:main:main",
    runs: params?.runs ?? [buildSubagentRun()],
    restTokens: params?.restTokens ?? [],
  } as Parameters<typeof handleSubagentsSendAction>[0];
}
