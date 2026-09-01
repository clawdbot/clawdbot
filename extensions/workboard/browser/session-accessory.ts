import { html, nothing, render } from "lit";
import type { ControlUiAccessory } from "openclaw/plugin-sdk/control-ui";
import { createWorkboardClient } from "./api/gateway.ts";
import { icons } from "./components/icons.ts";
import { t } from "./i18n/index.ts";
import {
  acquireWorkboardSessionCardLookup,
  type WorkboardSessionCardMatch,
} from "./lib/workboard/session-card-lookup.ts";
import { workboardPageTarget } from "./pages/workboard/workboard-page.ts";

export const mountWorkboardSessionAccessory: ControlUiAccessory["mount"] = (
  container,
  initialContext,
) => {
  let context = initialContext;
  const host = context.host;
  const client = createWorkboardClient(host);
  let match: WorkboardSessionCardMatch | null = null;
  let lease: ReturnType<typeof acquireWorkboardSessionCardLookup> | null = null;
  let unsubscribe: (() => void) | null = null;
  let key = "";
  const draw = () => {
    const target = match ? workboardPageTarget(match.boardId) : null;
    render(
      match && context.presented && target
        ? html`<a
            class="workboard-session-chip"
            href=${host.navigation.pageHref(target)}
            aria-label=${`${match.title} — ${t(`workboard.status.${match.status}`)}`}
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
              host.navigation.openPage(target);
            }}
            >${icons.kanban}<span class="workboard-session-chip__title">${match.title}</span
            ><span class="workboard-session-chip__status"
              >${t(`workboard.status.${match.status}`)}</span
            ></a
          >`
        : nothing,
      container,
    );
  };
  const release = () => {
    unsubscribe?.();
    unsubscribe = null;
    lease?.release();
    lease = null;
    key = "";
    match = null;
  };
  const sync = () => {
    const nextKey =
      context.presented && host.connection.connected ? context.props.sessionKey.trim() : "";
    if (key !== nextKey) {
      release();
      key = nextKey;
      if (key) {
        lease = acquireWorkboardSessionCardLookup(client);
        unsubscribe = lease.subscribe(key, (next) => {
          match = next;
          draw();
        });
      }
    }
    draw();
  };
  const stopHost = host.subscribe(sync);
  sync();
  return {
    update(next) {
      context = next;
      sync();
    },
    dispose() {
      stopHost();
      release();
      render(nothing, container);
    },
  };
};
