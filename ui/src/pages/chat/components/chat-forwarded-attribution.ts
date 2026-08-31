// Attribution row for cross-session (sessions_send) forwarded messages.
import { html, nothing } from "lit";
import type { AgentsListResult } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";

type ForwardedAttributionOptions = {
  agentId?: string;
  agents?: AgentsListResult["agents"];
  mainKey?: string;
};

/**
 * Label rules (operator decision, 2026-08-30): an agent's main session reads
 * as the agent itself ("From roboclaw"); other sessions read as the session
 * name (titler-resolved), prefixed with the agent's display name only when
 * the sender is a different agent ("From democlaw — bench").
 */
export function renderForwardedAttribution(group: MessageGroup, opts: ForwardedAttributionOptions) {
  const sourceSessionKey = group.senderSession?.sessionKey;
  const sourceParsed = sourceSessionKey ? parseAgentSessionKey(sourceSessionKey) : null;
  // Only agent-prefixed keys are navigable: the titler, hovercard, and click
  // handlers all reject other shapes, so a legacy key must stay plain text
  // instead of becoming a focusable link that goes nowhere.
  const linkableSourceKey = sourceParsed ? sourceSessionKey : undefined;
  const sourceAgentDisplayName = sourceParsed
    ? opts.agents?.find((agent) => agent.id === sourceParsed.agentId)?.identity?.name?.trim() ||
      sourceParsed.agentId
    : undefined;
  const sourceIsMainSession = Boolean(
    sourceParsed && opts.mainKey && sourceParsed.rest === opts.mainKey,
  );
  const sourceMainLabel = sourceIsMainSession ? sourceAgentDisplayName : undefined;
  const sourceAgentPrefix =
    !sourceIsMainSession && sourceParsed && sourceParsed.agentId !== opts.agentId
      ? sourceAgentDisplayName
      : undefined;
  return html`
    <div class="chat-reply-attribution">
      <span class="chat-reply-attribution__icon" aria-hidden="true">${icons.forward}</span>
      ${linkableSourceKey
        ? // The titler owns child text (.textContent keeps Lit's part out of
          // it). A rendered group's source never changes: messages are
          // immutable and grouping splits on senderSession, so no keyed
          // remount is needed. Main-session sources pre-title as the agent's
          // display name (an agent's main session IS the agent); the titler
          // still stamps the href but leaves pre-titled text alone.
          html`<span>${t("chat.messages.forwardedFrom")}</span>
            ${sourceAgentPrefix ? html`<span>${sourceAgentPrefix} —</span>` : nothing}
            <a
              class="markdown-session-link${sourceMainLabel
                ? " markdown-session-link--titled"
                : ""}"
              role="link"
              tabindex="0"
              data-session-key=${linkableSourceKey}
              .textContent=${sourceMainLabel ?? linkableSourceKey}
            ></a>`
        : sourceSessionKey
          ? html`<span>${t("chat.messages.forwardedFrom")}</span> <span>${sourceSessionKey}</span>`
          : html`<span
              >${group.senderSession?.agentId
                ? t("chat.messages.forwardedFromAgent", { agentId: group.senderSession.agentId })
                : t("chat.messages.forwardedMessage")}</span
            >`}
    </div>
  `;
}
