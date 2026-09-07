import { html, nothing } from "lit";
import "../../../components/elapsed-time.ts";
import "../../../components/working-phrase.ts";
import { icons } from "../../../components/icons.ts";
import { i18n, t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { TurnRecap } from "../chat-progress.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

const TURN_RECAP_DURATION_UNITS = [
  { seconds: 86_400, unit: "day" },
  { seconds: 3_600, unit: "hour" },
  { seconds: 60, unit: "minute" },
  { seconds: 1, unit: "second" },
] as const;

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

// 0 is valid; only null/undefined means "unknown".
function outputTokensLabel(outputTokens: number): string {
  return outputTokens === 1
    ? t("chat.turnRecap.tokensOne")
    : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(outputTokens) });
}

export function renderChatWorkingIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  options: {
    waitingApproval?: boolean;
    startupLabel?: string;
    outputTokens?: number | null;
    presentation?: "standalone" | "continuation";
  } = {},
) {
  const waitingApproval = options.waitingApproval === true;
  const continuation = options.presentation === "continuation";
  const statusLabel = waitingApproval
    ? t("chat.waitingForApproval")
    : options.startupLabel || t("common.working");
  const working = !waitingApproval && !options.startupLabel;
  // Providers report exact usage at response boundaries, not per text delta.
  // Keep the latest count visible while the run continues through tools.
  const outputTokens = options.outputTokens;
  // The animated claw stays decorative; the text status exposes progress without
  // announcing every elapsed-time tick to screen readers.
  return html`
    <div
      class="chat-working-indicator ${continuation ? "chat-working-indicator--continuation" : ""}"
      role="status"
      aria-live="off"
    >
      ${
        continuation
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
            `
      }
      <span class="chat-working-indicator__status">
        <span class=${working && !continuation ? "sr-only" : ""}>${statusLabel}</span>
        ${
          waitingApproval
            ? nothing
            : html`
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
              `
        }
        ${
          outputTokens !== null && outputTokens !== undefined
            ? html`
                <span aria-hidden="true">·</span>
                <span class="chat-working-indicator__tokens"
                  >${outputTokensLabel(outputTokens)}</span
                >
              `
            : working
              ? html`
                  <openclaw-working-phrase
                    aria-hidden="true"
                    .startMs=${part.startedAt}
                    .seed=${part.key}
                  ></openclaw-working-phrase>
                `
              : nothing
        }
      </span>
    </div>
  `;
}

/** Post-turn recap row: once the run settles, the parked claw reports how
 * long the turn took and its latest known output usage. Sticky until the
 * next run replaces it. */
export function renderTurnRecapRow(
  recap: TurnRecap,
  options: { presentation?: "standalone" | "continuation" } = {},
) {
  const continuation = options.presentation === "continuation";
  // Sub-second turns still read as one second; terminal recaps favor full words.
  const duration = formatTurnRecapDuration(recap.runtimeMs);
  const tokens =
    typeof recap.outputTokens === "number" ? outputTokensLabel(recap.outputTokens) : null;
  return html`
    <div
      class="chat-tasks-status chat-turn-recap ${
        continuation ? "chat-turn-recap--continuation" : ""
      }"
      role="status"
    >
      ${
        continuation
          ? nothing
          : html`<span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>`
      }
      <span>${t("chat.turnRecap.doneIn", { duration })}</span>
      ${
        tokens === null
          ? nothing
          : html`
              <span class="chat-tasks-status__sep" aria-hidden="true">·</span>
              <span>${tokens}</span>
            `
      }
    </div>
  `;
}
