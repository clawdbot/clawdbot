import { html, nothing, type TemplateResult } from "lit";
import { renderSessionsHubTabs, type SessionsHubTab } from "./sessions-hub-tabs.ts";

type SessionsHubHeaderProps = {
  active: SessionsHubTab;
  title: unknown;
  actions?: unknown;
  onSelect: (tab: SessionsHubTab) => void;
};

export function renderSessionsHubHeader(props: SessionsHubHeaderProps): TemplateResult {
  return html`
    <section class="content-header content-header--page sessions-hub-header">
      <div class="sessions-hub-header__title">
        <div class="page-title">${props.title}</div>
      </div>
      ${renderSessionsHubTabs({ active: props.active, onSelect: props.onSelect })}
      <div class="sessions-hub-header__actions">${props.actions ?? nothing}</div>
    </section>
  `;
}
