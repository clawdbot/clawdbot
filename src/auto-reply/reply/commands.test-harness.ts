import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext } from "./commands-context.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

export function buildCommandTestParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
  options?: {
    workspaceDir?: string;
  },
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim(),
    commandAuthorized: true,
  });

  const params: HandleCommandsParams = {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: options?.workspaceDir ?? "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
  return params;
}
