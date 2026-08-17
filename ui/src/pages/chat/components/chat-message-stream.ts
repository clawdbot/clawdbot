import { html, nothing } from "lit";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { AssistantIdentity } from "../../../lib/assistant-identity.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatRunStartupPhase } from "../chat-run-startup.ts";
import type { PlanStatus } from "../tool-stream.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderChatTimestamp } from "./chat-message-timestamp.ts";
import { renderChatPlanChecklist } from "./chat-plan-checklist.ts";
import { renderChatQuestionSummary } from "./chat-question-card.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { shouldToggleSelectableDisclosure } from "./chat-tool-cards.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

/** A contiguous run of in-flight streaming items rendered under one assistant group. */
export type StreamGroupPart = Extract<
  ChatItem,
  { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" } | { kind: "plan" }
>;

type StreamMessageOptions = Pick<
  Parameters<typeof renderGroupedMessage>[2],
  | "sessionKey"
  | "boardProvider"
  | "agentId"
  | "runActive"
  | "onRequestUpdate"
  | "canvasPluginSurfaceUrl"
  | "basePath"
  | "localMediaPreviewRoots"
  | "assistantAttachmentAuthToken"
  | "resolveArtifactDownload"
  | "onAssistantAttachmentLoaded"
  | "onRequestOpenImage"
  | "onOpenImage"
  | "embedSandboxMode"
  | "allowExternalEmbedUrls"
  | "onOpenWorkspaceFile"
>;

export type StreamGroupOptions = StreamMessageOptions & {
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: AssistantIdentity;
  showAssistantAvatar?: boolean;
  planStatus?: PlanStatus | null;
  planActive?: boolean;
  startupPhase?: ChatRunStartupPhase;
  waitingApproval?: boolean;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

function renderQuestionStreamPart(
  part: Extract<StreamGroupPart, { kind: "question" }>,
  opts: StreamGroupOptions,
) {
  const prompt = opts.questionPrompts?.get(part.questionId);
  return prompt ? renderChatQuestionSummary(prompt) : nothing;
}

export function renderStreamGroupParts(
  parts: StreamGroupPart[],
  opts: StreamGroupOptions,
  presentation: "standalone" | "continuation",
) {
  return parts.map((part) =>
    part.kind === "reading-indicator"
      ? renderChatWorkingIndicator(part, {
          waitingApproval: opts.waitingApproval === true,
          startupPhase: opts.startupPhase,
          outputTokens: opts.runOutputTokens,
          presentation,
        })
      : part.kind === "question"
        ? renderQuestionStreamPart(part, opts)
        : part.kind === "plan"
          ? renderChatPlanChecklist(opts.planStatus, {
              active: opts.planActive === true,
              variant: "card",
            })
          : renderGroupedMessage(
              {
                role: "assistant",
                content: [{ type: "text", text: part.text }],
                timestamp: part.startedAt,
              },
              part.key,
              {
                isStreaming: part.isStreaming,
                showReasoning: false,
                sessionKey: opts.sessionKey,
                boardProvider: opts.boardProvider,
                agentId: opts.agentId,
                runActive: opts.runActive,
                onRequestUpdate: opts.onRequestUpdate,
                canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
                basePath: opts.basePath,
                localMediaPreviewRoots: opts.localMediaPreviewRoots,
                assistantAttachmentAuthToken: opts.assistantAttachmentAuthToken,
                resolveArtifactDownload: opts.resolveArtifactDownload,
                onAssistantAttachmentLoaded: opts.onAssistantAttachmentLoaded,
                onRequestOpenImage: opts.onRequestOpenImage,
                onOpenImage: opts.onOpenImage,
                embedSandboxMode: opts.embedSandboxMode,
                allowExternalEmbedUrls: opts.allowExternalEmbedUrls,
                onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
              },
              opts.onOpenSidebar,
            ),
  );
}

// One assistant group per contiguous run of streaming items: a reply that
// arrives as several stream segments renders under a single avatar/footer
// instead of flashing a separate avatar+bubble per segment (#63956).
export function renderStreamGroup(parts: StreamGroupPart[], opts: StreamGroupOptions = {}) {
  const { assistant, basePath, assistantAttachmentAuthToken } = opts;
  const name = assistant?.name ?? "Assistant";
  // Footer (sender + time) anchors to the earliest streamed segment; a run that
  // is only the reading indicator has no timestamp and therefore no footer.
  const streamStarts = parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const footerStartedAt = streamStarts.length > 0 ? Math.min(...streamStarts) : null;
  // While the agent works with nothing streamed yet the run is pure claw: no
  // avatar next to it - the punching pincer is the whole signal. The avatar
  // arrives with the first stream part unless the presentation opts out.
  const workingOnly = parts.every((part) => part.kind !== "stream");
  const avatar =
    workingOnly || opts.showAssistantAvatar === false
      ? nothing
      : renderChatAvatar("assistant", assistant, undefined, basePath, assistantAttachmentAuthToken);
  const groupClass = `chat-group assistant${workingOnly ? " chat-group--working" : ""}${footerStartedAt !== null ? " chat-group--with-footer" : ""}`;

  return html`
    <div class=${groupClass} data-chat-row-key=${parts[0]?.key ?? nothing}>
      ${avatar}
      <div class="chat-group-messages">${renderStreamGroupParts(parts, opts, "standalone")}</div>
      ${footerStartedAt !== null
        ? html`
            <div class="chat-group-footer">
              <div class="chat-group-footer__meta">
                <span class="chat-sender-name">${name}</span>
                ${renderChatTimestamp(footerStartedAt)}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

/**
 * Collapsed-turn rollup header: one slim "Worked for X" disclosure standing in
 * for the turn's intermediate work once the run is done. The check icon is
 * the turn's done indicator; the expanded groups render after this row.
 */
export function renderWorkGroupSummary(
  item: { key: string; durationMs: number | null },
  opts: { expanded: boolean; onToggle: () => void },
) {
  const duration = formatDurationCompact(item.durationMs);
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  return html`
    <div class="chat-group tool chat-group--work" data-chat-row-key=${item.key}>
      <span class="chat-work-group__gutter" aria-hidden="true"></span>
      <div class="chat-group-messages">
        <div class="chat-activity-group chat-work-group ${opts.expanded ? "is-open" : ""}">
          <button
            class="chat-inline-disclosure chat-activity-group__summary"
            type="button"
            aria-expanded=${String(opts.expanded)}
            @click=${(event: MouseEvent) => {
              if (shouldToggleSelectableDisclosure(event)) {
                opts.onToggle();
              }
            }}
          >
            <span class="chat-activity-group__icon">${icons.check}</span>
            <span class="chat-activity-group__label" title=${label}>${label}</span>
            <span class="chat-inline-disclosure__chevron" aria-hidden="true"
              >${icons.chevronDown}</span
            >
          </button>
        </div>
      </div>
    </div>
  `;
}
