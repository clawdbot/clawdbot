import { html, nothing } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/working-phrase.ts";
import { i18n, t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatRunStartupPhase } from "../chat-run-startup.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

// Almost every run uses the default loop; an alternate move fires once, then yields back to it.
const STARTUP_STATUS_LABEL_KEYS = {
  preparing_workspace: "chat.startupStatus.preparingWorkspace",
  provisioning_environment: "chat.startupStatus.provisioningEnvironment",
  preparing_context: "chat.startupStatus.preparingContext",
  starting_model: "chat.startupStatus.startingModel",
} as const satisfies Record<ChatRunStartupPhase, Parameters<typeof t>[0]>;
const TURN_RECAP_DURATION_UNITS = [
  { seconds: 86_400, unit: "day" },
  { seconds: 3_600, unit: "hour" },
  { seconds: 60, unit: "minute" },
  { seconds: 1, unit: "second" },
] as const;

function startupStatusLabel(phase: ChatRunStartupPhase): string {
  return t(STARTUP_STATUS_LABEL_KEYS[phase]);
}

function formatTurnRecapDuration(ms: number): string {
  let remainingSeconds = Math.max(1, Math.round(ms / 1_000));
  const locale = i18n.getLocale();
  const parts: string[] = [];
  for (const { seconds, unit } of TURN_RECAP_DURATION_UNITS) {
    const value = Math.floor(remainingSeconds / seconds);
    if (value === 0) {
      continue;
    }
    parts.push(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
      }).format(value),
    );
    remainingSeconds -= value * seconds;
    if (parts.length === 2) {
      break;
    }
  }
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}

function renderLiveOutputTokens(outputTokens: number | null | undefined) {
  if (outputTokens === null || outputTokens === undefined) {
    return nothing;
  }
  return html`
    <span aria-hidden="true">·</span>
    <span class="chat-working-indicator__tokens">
      ${t("chat.outputTokens", { count: formatCompactTokenCount(outputTokens) })}
    </span>
  `;
}

export function renderChatWorkingIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  options: {
    waitingApproval?: boolean;
    startupPhase?: ChatRunStartupPhase;
    outputTokens?: number | null;
    presentation?: "standalone" | "continuation";
  } = {},
) {
  const waitingApproval = options.waitingApproval === true;
  const continuation = options.presentation === "continuation";
  // The animated claw stays decorative; the text status exposes progress without
  // announcing every elapsed-time tick to screen readers.
  return html`
    <div
      class="chat-working-indicator ${continuation ? "chat-working-indicator--continuation" : ""}"
      role="status"
      aria-live="off"
    >
      ${continuation
        ? nothing
        : html`
            <div
              class="chat-bubble chat-reading-indicator ${selectWorkingClawSurprise(part.key, {
                eligible: !waitingApproval,
              })}"
              aria-hidden="true"
            >
              ${icons.claw}
            </div>
          `}
      <span class="chat-working-indicator__status">
        ${waitingApproval
          ? html`<span>${t("chat.waitingForApproval")}</span>`
          : options.startupPhase
            ? html`
                <span>${startupStatusLabel(options.startupPhase)}</span>
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
                ${renderLiveOutputTokens(options.outputTokens)}
              `
            : html`
                <span class=${continuation ? "" : "agent-chat__sr-only"}
                  >${t("common.working")}</span
                >
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
                <openclaw-working-phrase
                  aria-hidden="true"
                  .startMs=${part.startedAt}
                  .seed=${part.key}
                ></openclaw-working-phrase>
                ${renderLiveOutputTokens(options.outputTokens)}
              `}
      </span>
    </div>
  `;
}

/** Post-turn recap row: once the run settles, the parked claw reports how
 * long the turn took (and its output tokens when the terminal patch carried
 * them). Sticky until the next run replaces it. */
export function renderTurnRecapRow(
  recap: TurnRecap,
  options: { presentation?: "standalone" | "continuation" } = {},
) {
  const continuation = options.presentation === "continuation";
  // Sub-second turns still read as one second; terminal recaps favor full words.
  const duration = formatTurnRecapDuration(recap.runtimeMs);
  // 0 is a valid count (command-only turns); only null means "unknown".
  const tokens =
    typeof recap.outputTokens === "number"
      ? recap.outputTokens === 1
        ? t("chat.turnRecap.tokensOne")
        : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(recap.outputTokens) })
      : null;
  return html`
    <div
      class="chat-tasks-status chat-turn-recap ${continuation
        ? "chat-turn-recap--continuation"
        : ""}"
      role="status"
    >
      ${continuation
        ? nothing
        : html`<span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>`}
      <span>${t("chat.turnRecap.doneIn", { duration })}</span>
      ${tokens === null
        ? nothing
        : html`
            <span class="chat-tasks-status__sep" aria-hidden="true">·</span>
            <span>${tokens}</span>
          `}
    </div>
  `;
}
