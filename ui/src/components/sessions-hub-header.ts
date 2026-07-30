import { html, nothing, type TemplateResult } from "lit";
import { renderSessionsHubTabs, type SessionsHubTab } from "./sessions-hub-tabs.ts";

type SessionsHubHeaderProps = {
  active: SessionsHubTab;
  title: unknown;
  subtitle?: unknown;
  actions?: unknown;
  onSelect: (tab: SessionsHubTab) => void;
};

export function renderSessionsHubHeader(props: SessionsHubHeaderProps): TemplateResult {
  return html`
    <section class="content-header content-header--page hub-page-header sessions-hub-header">
      <div class="hub-page-header__title">
        <div class="page-title">${props.title}</div>
        ${props.subtitle ? html`<div class="page-subtitle">${props.subtitle}</div>` : nothing}
      </div>
      <div class="hub-page-header__tabs">
        ${renderSessionsHubTabs({ active: props.active, onSelect: props.onSelect })}
      </div>
      <div class="hub-page-header__actions">${props.actions ?? nothing}</div>
    </section>
  `;
}
