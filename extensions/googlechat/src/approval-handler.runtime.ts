import type {
  ChannelApprovalCapabilityHandlerContext,
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveGoogleChatAccount, type ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";
import {
  buildGoogleChatApprovalActionParameters,
  createGoogleChatApprovalToken,
  GOOGLECHAT_APPROVAL_ACTION,
  registerGoogleChatApprovalCardBinding,
  registerGoogleChatManualApprovalFollowupSuppression,
  unregisterGoogleChatManualApprovalFollowupSuppression,
  unregisterGoogleChatApprovalCardBindings,
} from "./approval-card-actions.js";
import {
  isGoogleChatNativeApprovalClientEnabled,
  shouldHandleGoogleChatNativeApprovalRequest,
} from "./approval-native.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";
import type { GoogleChatCardV2 } from "./types.js";

const log = createSubsystemLogger("googlechat/approvals");
const GOOGLECHAT_APPROVAL_CARD_ID = "openclaw-approval";
const MAX_TEXT_PARAGRAPH_CHARS = 1800;

type GoogleChatApprovalHandlerContext = {
  account?: ResolvedGoogleChatAccount;
};

type GoogleChatApprovalActionToken = {
  token: string;
  decision: ExecApprovalDecision;
};

type GoogleChatPendingDelivery = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  expiresAtMs: number;
  cardsV2: GoogleChatCardV2[];
  actionTokens: GoogleChatApprovalActionToken[];
  allowedDecisions: readonly ExecApprovalDecision[];
};

type PreparedGoogleChatTarget = {
  to: string;
  threadName?: string;
};

type GoogleChatPendingEntry = {
  accountId: string;
  spaceName: string;
  messageName: string;
  threadName?: string;
  actionTokens: GoogleChatApprovalActionToken[];
};

type GoogleChatFinalDelivery = {
  cardsV2: GoogleChatCardV2[];
};

function resolveHandlerAccount(
  params: ChannelApprovalCapabilityHandlerContext,
): ResolvedGoogleChatAccount | null {
  const context = params.context as GoogleChatApprovalHandlerContext | undefined;
  const account =
    context?.account ??
    resolveGoogleChatAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  if (
    !account.enabled ||
    account.credentialSource === "none" ||
    account.tokenStatus === "configured_unavailable"
  ) {
    return null;
  }
  return account;
}

function escapeGoogleChatText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateText(text: string, maxChars = MAX_TEXT_PARAGRAPH_CHARS): string {
  return text.length <= maxChars ? text : `${truncateUtf16Safe(text, maxChars - 3)}...`;
}

function buildMetadataText(metadata: readonly { label: string; value: string }[]): string {
  return metadata
    .map(
      (item) => `<b>${escapeGoogleChatText(item.label)}:</b> ${escapeGoogleChatText(item.value)}`,
    )
    .join("<br>");
}

function formatDecision(decision: ExecApprovalDecision): string {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function buildMainTextWidget(text: string) {
  return {
    textParagraph: {
      text: escapeGoogleChatText(truncateText(text)),
    },
  };
}

function buildHtmlTextWidget(text: string) {
  return {
    textParagraph: {
      text: truncateText(text),
    },
  };
}

function buildExecPendingSections(view: PendingApprovalView) {
  if (view.approvalKind !== "exec") {
    return [];
  }
  return [
    {
      header: "Command",
      widgets: [buildMainTextWidget(view.commandText)],
    },
    ...(view.commandPreview && view.commandPreview !== view.commandText
      ? [
          {
            header: "Preview",
            widgets: [buildMainTextWidget(view.commandPreview)],
          },
        ]
      : []),
  ];
}

function buildPluginPendingSections(view: PendingApprovalView) {
  if (view.approvalKind !== "plugin") {
    return [];
  }
  return [
    {
      header: "Request",
      widgets: [
        buildHtmlTextWidget(
          `<b>${escapeGoogleChatText(view.title)}</b>${
            view.description ? `<br>${escapeGoogleChatText(view.description)}` : ""
          }`,
        ),
      ],
    },
  ];
}

function buildMetadataSection(
  view: PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView,
) {
  const metadata = [{ label: "Approval ID", value: view.approvalId }, ...view.metadata];
  return metadata.length > 0
    ? [
        {
          header: "Details",
          widgets: [buildHtmlTextWidget(buildMetadataText(metadata))],
        },
      ]
    : [];
}

function buildActionSection(params: { actionFunction: string; view: PendingApprovalView }): {
  section: NonNullable<GoogleChatCardV2["card"]["sections"]>[number];
  actionTokens: GoogleChatApprovalActionToken[];
} {
  const { actionFunction, view } = params;
  const actionTokens = view.actions.map((action) => ({
    token: createGoogleChatApprovalToken(),
    decision: action.decision,
  }));
  return {
    actionTokens,
    section: {
      widgets: [
        {
          buttonList: {
            buttons: view.actions.map((action, index) => {
              const actionToken = actionTokens[index];
              if (!actionToken) {
                throw new Error("Google Chat approval action token missing.");
              }
              return {
                text: action.label,
                onClick: {
                  action: {
                    function: actionFunction,
                    parameters: buildGoogleChatApprovalActionParameters(actionToken.token),
                    loadIndicator: "SPINNER" as const,
                  },
                },
              };
            }),
          },
        },
      ],
    },
  };
}

function buildPendingPayload(params: {
  actionFunction: string;
  nowMs: number;
  view: PendingApprovalView;
}): GoogleChatPendingDelivery {
  const { actionFunction, nowMs, view } = params;
  const { section: actionSection, actionTokens } = buildActionSection({ actionFunction, view });
  const title =
    view.approvalKind === "plugin" ? "Plugin Approval Required" : "Exec Approval Required";
  const subtitle = `Expires in ${Math.max(0, Math.ceil((view.expiresAtMs - nowMs) / 1000))}s`;
  const card: GoogleChatCardV2 = {
    cardId: GOOGLECHAT_APPROVAL_CARD_ID,
    card: {
      header: { title, subtitle },
      sections: [
        ...buildExecPendingSections(view),
        ...buildPluginPendingSections(view),
        ...buildMetadataSection(view),
        actionSection,
      ],
    },
  };
  return {
    approvalId: view.approvalId,
    approvalKind: view.approvalKind,
    expiresAtMs: view.expiresAtMs,
    cardsV2: [card],
    actionTokens,
    allowedDecisions: view.actions.map((action) => action.decision),
  };
}

function resolveApprovalActionFunction(params: ChannelApprovalCapabilityHandlerContext): string {
  const account = resolveHandlerAccount(params);
  const audience = normalizeOptionalString(account?.config.audience);
  const appPrincipal = normalizeOptionalString(account?.config.appPrincipal);
  return account?.config.audienceType === "app-url" && audience && appPrincipal
    ? audience
    : GOOGLECHAT_APPROVAL_ACTION;
}

function buildResolvedPayload(view: ResolvedApprovalView): GoogleChatFinalDelivery {
  const resolvedBy = normalizeOptionalString(view.resolvedBy);
  const card: GoogleChatCardV2 = {
    cardId: GOOGLECHAT_APPROVAL_CARD_ID,
    card: {
      header: {
        title: `${view.approvalKind === "plugin" ? "Plugin" : "Exec"} Approval: ${formatDecision(
          view.decision,
        )}`,
        subtitle: resolvedBy ? `Resolved by ${resolvedBy}` : "Resolved",
      },
      sections: buildMetadataSection(view),
    },
  };
  return {
    cardsV2: [card],
  };
}

function buildExpiredPayload(view: ExpiredApprovalView): GoogleChatFinalDelivery {
  const card: GoogleChatCardV2 = {
    cardId: GOOGLECHAT_APPROVAL_CARD_ID,
    card: {
      header: {
        title: `${view.approvalKind === "plugin" ? "Plugin" : "Exec"} Approval Expired`,
        subtitle: "This approval request expired before it was resolved.",
      },
      sections: buildMetadataSection(view),
    },
  };
  return {
    cardsV2: [card],
  };
}

export const googleChatApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  GoogleChatPendingDelivery,
  PreparedGoogleChatTarget,
  GoogleChatPendingEntry,
  readonly string[],
  GoogleChatFinalDelivery
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ cfg, accountId }) =>
      isGoogleChatNativeApprovalClientEnabled({ cfg, accountId }),
    shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
      shouldHandleGoogleChatNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  },
  presentation: {
    buildPendingPayload: ({ cfg, accountId, context, nowMs, view }) =>
      buildPendingPayload({
        actionFunction: resolveApprovalActionFunction({ cfg, accountId, context }),
        nowMs,
        view,
      }),
    buildResolvedResult: ({ view }) => ({ kind: "update", payload: buildResolvedPayload(view) }),
    buildExpiredResult: ({ view }) => ({ kind: "update", payload: buildExpiredPayload(view) }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: {
        to: plannedTarget.target.to,
        threadName:
          plannedTarget.target.threadId != null ? String(plannedTarget.target.threadId) : undefined,
      },
    }),
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const account = resolveHandlerAccount({ cfg, accountId, context });
      if (!account) {
        return null;
      }
      const spaceName = await resolveGoogleChatOutboundSpace({
        account,
        target: preparedTarget.to,
      });
      // Native delivery can race the model's message tool follow-up; register before
      // the send awaits so the channel-local outbound filter can suppress duplicates.
      registerGoogleChatManualApprovalFollowupSuppression({
        approvalId: pendingPayload.approvalId,
        approvalKind: pendingPayload.approvalKind,
        allowedDecisions: pendingPayload.allowedDecisions,
        expiresAtMs: pendingPayload.expiresAtMs,
      });
      let sent: Awaited<ReturnType<typeof sendGoogleChatMessage>>;
      try {
        sent = await sendGoogleChatMessage({
          account,
          space: spaceName,
          cardsV2: pendingPayload.cardsV2,
          thread: preparedTarget.threadName,
        });
      } catch (error) {
        unregisterGoogleChatManualApprovalFollowupSuppression(pendingPayload.approvalId);
        throw error;
      }
      if (!sent?.messageName) {
        unregisterGoogleChatManualApprovalFollowupSuppression(pendingPayload.approvalId);
        return null;
      }
      return {
        accountId: account.accountId,
        spaceName,
        messageName: sent.messageName,
        ...(preparedTarget.threadName ? { threadName: preparedTarget.threadName } : {}),
        actionTokens: pendingPayload.actionTokens,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const account = resolveHandlerAccount({ cfg, accountId, context });
      if (!account) {
        return;
      }
      await updateGoogleChatMessage({
        account,
        messageName: entry.messageName,
        cardsV2: payload.cardsV2,
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, approvalKind, view, pendingPayload }) => {
      const tokens: string[] = [];
      for (const actionToken of entry.actionTokens) {
        const ok = registerGoogleChatApprovalCardBinding({
          token: actionToken.token,
          accountId: entry.accountId,
          approvalId: request.id,
          approvalKind,
          decision: actionToken.decision,
          allowedDecisions: pendingPayload.allowedDecisions,
          spaceName: entry.spaceName,
          messageName: entry.messageName,
          threadName: entry.threadName ?? null,
          expiresAtMs: view.expiresAtMs,
        });
        if (ok) {
          tokens.push(actionToken.token);
        }
      }
      return tokens.length > 0 ? tokens : null;
    },
    unbindPending: ({ binding }) => {
      unregisterGoogleChatApprovalCardBindings(binding);
    },
    cancelDelivered: ({ entry }) => {
      unregisterGoogleChatApprovalCardBindings(
        entry.actionTokens.map((actionToken) => actionToken.token),
      );
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`googlechat approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
