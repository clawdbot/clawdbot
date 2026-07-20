import { html } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";

// One salt per page load keeps each run stable while varying the animation between visits.
const PUNCH_SALT = Math.trunc(Math.random() * 0xffffffff);
const PUNCH_STANCES: Array<[stance: string, weight: number]> = [
  ["", 47],
  ["chat-reading-indicator--southpaw", 35],
  ["chat-reading-indicator--flurry", 12],
  ["chat-reading-indicator--haymaker", 6],
];
function punchStanceClass(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const total = PUNCH_STANCES.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = ((((hash ^ PUNCH_SALT) >>> 0) % 1000) / 1000) * total;
  for (const [stance, weight] of PUNCH_STANCES) {
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
      <div
        class="chat-bubble chat-reading-indicator ${punchStanceClass(part.key)}"
        aria-hidden="true"
      >
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
            `}
      </span>
    </div>
  `;
}
