import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { GoogleChatCardV2 } from "./types.js";

const GOOGLECHAT_APPROVAL_CARD_ID = "openclaw-approval";
const MAX_TEXT_PARAGRAPH_CHARS = 1800;

function escapeGoogleChatText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateText(text: string): string {
  return text.length <= MAX_TEXT_PARAGRAPH_CHARS
    ? text
    : `${truncateUtf16Safe(text, MAX_TEXT_PARAGRAPH_CHARS - 3)}...`;
}

function formatApprovalId(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function formatCanonicalOutcome(approval: ApprovalResolveResult["approval"]): string {
  switch (approval.status) {
    case "allowed":
      return approval.decision === "allow-always" ? "Allowed always" : "Allowed once";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
  }
  return "Unavailable";
}

function buildSubjectSection(
  presentation: ApprovalResolveResult["approval"]["presentation"],
): NonNullable<GoogleChatCardV2["card"]["sections"]>[number] {
  if (presentation.kind === "exec") {
    return {
      header: "Command",
      widgets: [
        {
          textParagraph: {
            text: escapeGoogleChatText(
              truncateText(presentation.commandPreview ?? presentation.commandText),
            ),
          },
        },
      ],
    };
  }
  const description = presentation.description.trim();
  const requestText = `<b>${escapeGoogleChatText(presentation.title)}</b>${
    description ? `<br>${escapeGoogleChatText(description)}` : ""
  }`;
  return {
    header: "Request",
    widgets: [{ textParagraph: { text: truncateText(requestText) } }],
  };
}

/** Render the canonical first-answer result without retaining any actionable buttons. */
export function buildGoogleChatCanonicalApprovalTerminalCards(
  result: ApprovalResolveResult,
): GoogleChatCardV2[] {
  const { approval } = result;
  const kindLabel = approval.presentation.kind === "plugin" ? "Plugin" : "Exec";
  const detailLines = [
    `<b>Approval ID:</b> ${escapeGoogleChatText(formatApprovalId(approval.id))}`,
    `<b>Status:</b> ${escapeGoogleChatText(approval.status)}`,
    ...(approval.status === "allowed" || approval.status === "denied"
      ? [`<b>Decision:</b> ${escapeGoogleChatText(approval.decision)}`]
      : []),
    `<b>Reason:</b> ${escapeGoogleChatText(approval.reason)}`,
  ];
  return [
    {
      cardId: GOOGLECHAT_APPROVAL_CARD_ID,
      card: {
        header: {
          title: `${kindLabel} Approval: ${formatCanonicalOutcome(approval)}`,
          subtitle: result.applied ? "Resolved by this action" : "Already resolved",
        },
        sections: [
          buildSubjectSection(approval.presentation),
          {
            header: "Details",
            widgets: [{ textParagraph: { text: truncateText(detailLines.join("<br>")) } }],
          },
        ],
      },
    },
  ];
}
