import { html, nothing, type TemplateResult } from "lit";
import type { SessionPlacementDiskSpace } from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { renderCopyButton } from "../../components/copy-button.ts";
import { formatWebUiIconErrorText } from "../../components/error-presentation.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { clampText } from "../../lib/format.ts";
import { renderWorkspaceConflictNotice } from "./components/chat-workspace-conflict.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";

export type ChatPlacementStartupNoticeProps = {
  placementStartup?: ApplicationPlacementStartupStatus | null;
  onRetrySessionPlacementStartup?: () => void;
};

type ChatViewNoticesProps = ChatPlacementStartupNoticeProps & {
  diskSpace?: SessionPlacementDiskSpace;
  error?: string | null;
  focusMode?: boolean;
  onDismissError?: () => void;
  onDismissWorkspaceConflict?: () => void;
  onToggleFocusMode?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

type ChatComposerNoticesProps = ChatPlacementStartupNoticeProps & {
  messages: readonly unknown[];
  runError?: { summary: string } | null;
  onDismissWorkspaceConflict?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

function renderDiskSpaceNotice(diskSpace: SessionPlacementDiskSpace | undefined) {
  if (!diskSpace || diskSpace.status === "ok") {
    return nothing;
  }
  const usedPercent =
    diskSpace.totalBytes > 0
      ? Math.round(((diskSpace.totalBytes - diskSpace.availableBytes) / diskSpace.totalBytes) * 100)
      : 0;
  const critical = diskSpace.status === "critical";
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--${critical
        ? "danger"
        : "warn"} chat-cloud-disk-space-notice"
      role=${critical ? "alert" : "status"}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      <div class="chat-composer-neighbor-card__copy">
        <strong
          >${t(critical ? "chat.diskSpace.criticalTitle" : "chat.diskSpace.warningTitle")}</strong
        >
        <span>
          ${t(critical ? "chat.diskSpace.criticalBody" : "chat.diskSpace.warningBody", {
            percent: String(usedPercent),
            free: formatBytes(diskSpace.availableBytes),
          })}
        </span>
      </div>
    </div>
  `;
}

function renderErrorNotice(
  error: string,
  action: TemplateResult | typeof nothing = nothing,
  displayError = formatWebUiIconErrorText(error),
) {
  const lines = displayError
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim());
  const [firstLine = ""] = lines;
  const summary = clampText(firstLine);
  const hasDetails = lines.some((line) => line !== "" && line !== summary);
  // Plain summaries wrap fully; only expandable previews may clip at narrow widths.
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--danger chat-error"
      role="alert"
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      ${hasDetails
        ? html`<details class="chat-error__content">
            <summary class="chat-error__summary">
              <strong>${summary}</strong>
              <span>${t("chat.details")}</span>
              <span class="chat-error__chevron" aria-hidden="true">${icons.chevronDown}</span>
              ${renderCopyButton(error, t("chat.copyError"))}
            </summary>
            <pre class="chat-error__diagnostic" tabindex="0" aria-label=${t("chat.errorDetails")}>
${displayError}</pre>
          </details>`
        : html`<span class="chat-error__content"
            ><strong>${summary}</strong>${renderCopyButton(error, t("chat.copyError"))}</span
          >`}
      ${action}
    </div>
  `;
}

export function renderChatTopbarNotices(props: ChatViewNoticesProps) {
  const dismiss = props.onDismissError
    ? html`
        <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
          <button
            class="chat-error__dismiss"
            type="button"
            @click=${props.onDismissError}
            aria-label=${t("chat.actions.dismissError")}
          >
            ${icons.x}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  return html`
    <div class="chat-topbar-notices">
      ${renderDiskSpaceNotice(props.diskSpace)}
      ${props.error ? renderErrorNotice(props.error, dismiss) : nothing}
      ${props.focusMode && props.onToggleFocusMode
        ? html`
            <openclaw-tooltip .content=${t("chat.actions.exitFocusMode")}>
              <button
                class="chat-focus-exit"
                type="button"
                @click=${props.onToggleFocusMode}
                aria-label=${t("chat.actions.exitFocusMode")}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          `
        : nothing}
    </div>
  `;
}

export function renderChatComposerNotices(props: ChatComposerNoticesProps) {
  return html`
    ${props.runError ? renderErrorNotice(props.runError.summary) : nothing}
    ${renderWorkspaceConflictNotice({
      conflict: props.workspaceConflict ?? undefined,
      onDismiss: props.onDismissWorkspaceConflict,
    })}
    ${renderPlacementStartupError(
      props.placementStartup,
      props.messages,
      props.onRetrySessionPlacementStartup,
    )}
  `;
}

function renderPlacementStartupError(
  status: ApplicationPlacementStartupStatus | null | undefined,
  messages: readonly unknown[],
  onRetry?: () => void,
) {
  if (status?.phase !== "failed") {
    return nothing;
  }
  const checking = status.action === "check-delivery";
  const statusError = status.error ?? t("newSession.createFailed");
  const error = checking
    ? [t("chat.queue.checkDeliveryHelp"), status.error].filter(Boolean).join("\n\n")
    : t("newSession.placementStartFailed", { error: statusError });
  const displayStatusError = formatWebUiIconErrorText(statusError);
  const displayError = checking
    ? [t("chat.queue.checkDeliveryHelp"), status.error ? displayStatusError : undefined]
        .filter(Boolean)
        .join("\n\n")
    : t("newSession.placementStartFailed", { error: displayStatusError });
  // History can own the bubble before startup observes its receipt. Keep the
  // banner action reachable when transcript deduplication hides the row.
  const hasInlineTurn =
    status.initialTurn && !findChatSubmissionMessage(messages, status.initialTurn.sendRunId, true);
  const retry =
    status.retryable && onRetry && !hasInlineTurn
      ? html`<button class="btn btn--sm" type="button" @click=${onRetry}>
          ${t(checking ? "chat.queue.checkDelivery" : "common.retry")}
        </button>`
      : nothing;
  return renderErrorNotice(error, retry, displayError);
}
