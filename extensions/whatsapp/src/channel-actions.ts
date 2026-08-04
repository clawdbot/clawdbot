// Whatsapp plugin module implements channel actions behavior.
import { Type } from "typebox";
import {
  createActionGate,
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  resolveWhatsAppReactionLevel,
  type ChannelMessageActionName,
  type OpenClawConfig,
} from "./channel-actions.runtime.js";

function areWhatsAppAgentReactionsEnabled(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return false;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return false;
  }
  return resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  }).agentReactionsEnabled;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return areWhatsAppAgentReactionsEnabled({
      cfg,
      accountId,
    });
  });
}

export function resolveWhatsAppAgentReactionGuidance(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!resolved.agentReactionsEnabled) {
    return undefined;
  }
  return resolved.agentReactionGuidance;
}

export function describeWhatsAppMessageActions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  if (!params.cfg.channels?.whatsapp) {
    return null;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  const actions = new Set<ChannelMessageActionName>();
  const canReact =
    params.accountId != null
      ? areWhatsAppAgentReactionsEnabled({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : hasAnyWhatsAppAccountWithAgentReactionsEnabled(params.cfg);
  if (canReact) {
    actions.add("react");
  }
  if (gate("polls")) {
    actions.add("poll");
  }
  actions.add("upload-file");
  return {
    actions: Array.from(actions),
    schema: {
      properties: {
        location: Type.Optional(
          Type.Object(
            {
              latitude: Type.Number({ minimum: -90, maximum: 90 }),
              longitude: Type.Number({ minimum: -180, maximum: 180 }),
              accuracy: Type.Optional(Type.Number({ minimum: 0, maximum: 1500 })),
              name: Type.Optional(Type.String({ minLength: 1 })),
              address: Type.Optional(Type.String({ minLength: 1 })),
            },
            {
              description:
                "Standalone WhatsApp location pin. Do not combine with message or media.",
            },
          ),
        ),
      },
      visibility: "all-configured" as const,
    },
  };
}
