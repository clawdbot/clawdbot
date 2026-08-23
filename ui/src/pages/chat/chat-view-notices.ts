import { html, nothing } from "lit";
import type { SessionPlacementDiskSpace } from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { renderPlacementStartupStatus } from "./components/chat-working-indicator.ts";
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
      class="callout ${critical ? "danger" : "warn"} chat-cloud-disk-space-notice"
      role=${critical ? "alert" : "status"}
    >
      <div class="chat-cloud-disk-space-notice__title">
        <span aria-hidden="true">${icons.alertTriangle}</span>
        <strong
          >${t(critical ? "chat.diskSpace.criticalTitle" : "chat.diskSpace.warningTitle")}</strong
        >
      </div>
      <p>
        ${t(critical ? "chat.diskSpace.criticalBody" : "chat.diskSpace.warningBody", {
          percent: String(usedPercent),
          free: formatBytes(diskSpace.availableBytes),
        })}
      </p>
    </div>
  `;
}

export function renderChatViewNotices(props: ChatViewNoticesProps) {
  return html`
    ${renderDiskSpaceNotice(props.diskSpace)}
    ${props.error
      ? html`
          <div class="chat-error" role="alert">
            <span class="chat-error__dot" aria-hidden="true"></span>
            <span class="chat-error__content">${props.error}</span>
            ${props.onDismissError
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
              : nothing}
          </div>
        `
      : nothing}
    ${renderWorkspaceConflictNotice({
      conflict: props.workspaceConflict ?? undefined,
      onDismiss: props.onDismissWorkspaceConflict,
    })}
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
    ${renderPlacementStartupStatus(props.placementStartup, props.onRetrySessionPlacementStartup)}
  `;
}
