import { html, nothing } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/working-phrase.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount, formatDurationCompact } from "../../../lib/format.ts";
import type { TurnRecap } from "../chat-progress.ts";

// One salt per page load keeps each run stable while varying the animation between visits.
// The default stance just claws in place; the busier stances stay rare on purpose.
const STANCE_SALT = Math.trunc(Math.random() * 0xffffffff);
const STANCES: Array<[stance: string, weight: number]> = [
  ["", 66],
  ["chat-reading-indicator--southpaw", 20],
  ["chat-reading-indicator--flurry", 5],
  ["chat-reading-indicator--spin", 4],
  ["chat-reading-indicator--shadowbox", 3],
  ["chat-reading-indicator--backflip", 2],
];
function stanceClass(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const total = STANCES.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = ((((hash ^ STANCE_SALT) >>> 0) % 1000) / 1000) * total;
  for (const [stance, weight] of STANCES) {
    roll -= weight;
    if (roll <= 0) {
      return stance;
    }
  }
  return "";
}

export function renderChatWorkingIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  waitingApproval = false,
) {
  // The animated claw stays decorative; the text status exposes progress without
  // announcing every elapsed-time tick to screen readers.
  return html`
    <div class="chat-working-indicator" role="status" aria-live="off">
      <div class="chat-bubble chat-reading-indicator ${stanceClass(part.key)}" aria-hidden="true">
        ${icons.claw}
      </div>
      <span class="chat-working-indicator__status">
        ${waitingApproval
          ? html`<span>${t("chat.waitingForApproval")}</span>`
          : html`
              <span class="agent-chat__sr-only">${t("common.working")}</span>
              <openclaw-elapsed-time
                class="chat-working-indicator__elapsed"
                .startMs=${part.startedAt}
              ></openclaw-elapsed-time>
              <openclaw-working-phrase
                aria-hidden="true"
                .startMs=${part.startedAt}
                .seed=${part.key}
              ></openclaw-working-phrase>
            `}
      </span>
    </div>
  `;
}

/** Post-turn recap row: once the run settles, the parked claw reports how
 * long the turn took (and its output tokens when the terminal patch carried
 * them). Sticky until the next run replaces it. */
export function renderTurnRecapRow(recap: TurnRecap) {
  // Sub-second turns still read "1s"; the clamp also keeps the type a string.
  const clampedMs = Math.max(1_000, recap.runtimeMs);
  const duration = formatDurationCompact(clampedMs, { spaced: true }) ?? "1s";
  // 0 is a valid count (command-only turns); only null means "unknown".
  const tokens =
    typeof recap.outputTokens === "number"
      ? recap.outputTokens === 1
        ? t("chat.turnRecap.tokensOne")
        : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(recap.outputTokens) })
      : null;
  return html`
    <div class="chat-tasks-status chat-turn-recap" role="status">
      <span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>
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
