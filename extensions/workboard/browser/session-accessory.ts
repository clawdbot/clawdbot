import { html, nothing, render } from "lit";
import type { ControlUiAccessory } from "openclaw/plugin-sdk/control-ui";
import { icons } from "./components/icons.ts";
import { t } from "./i18n/index.ts";
import { workboardCardBoardId } from "./lib/workboard/board-filter.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { isActiveWorkboardCard } from "./lib/workboard/card-state.ts";
import { findWorkboardSessionCard } from "./lib/workboard/session-links.ts";
import { matchesAgentScope } from "./pages/workboard/agent-filter.ts";
import { workboardPageTarget } from "./pages/workboard/workboard-page.ts";

export function createWorkboardSessionAccessory(
  workboard: WorkboardCapability,
): ControlUiAccessory["mount"] {
  return (container, initialContext) => {
    let context = initialContext;
    let disposed = false;
    const host = context.host;
    const draw = () => {
      const card =
        context.presented && host.connection.connected
          ? findWorkboardSessionCard(workboard.state.cards, context.props.sessionKey)
          : null;
      const target = card ? workboardPageTarget(workboardCardBoardId(card)) : null;
      render(
        card && isActiveWorkboardCard(card) && target
          ? html`<a
              class="workboard-session-chip"
              href=${host.navigation.pageHref(target)}
              aria-label=${`${card.title} — ${t(`workboard.status.${card.status}`)}`}
              @click=${(event: MouseEvent) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                if (
                  disposed ||
                  !context.presented ||
                  context.signal.aborted ||
                  !host.connection.connected
                ) {
                  return;
                }
                if (
                  !matchesAgentScope(
                    card,
                    host.agents.defaultId ?? host.connection.assistantAgentId,
                    host.agents.scopeId,
                  )
                ) {
                  host.agents.setScope(null);
                }
                host.navigation.openPage(target);
              }}
              >${icons.kanban}<span class="workboard-session-chip__title">${card.title}</span
              ><span class="workboard-session-chip__status"
                >${t(`workboard.status.${card.status}`)}</span
              ></a
            >`
          : nothing,
        container,
      );
    };
    const stopHost = host.subscribe(draw);
    const stopState = workboard.subscribe(draw);
    draw();
    return {
      update(next) {
        context = next;
        draw();
      },
      dispose() {
        disposed = true;
        stopHost();
        stopState();
        render(nothing, container);
      },
    };
  };
}
