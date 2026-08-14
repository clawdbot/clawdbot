import { html, nothing, type TemplateResult } from "lit";
import {
  describeSessionPrimaryState,
  renderSessionPrimaryState,
  type SessionPrimaryState,
} from "./session-primary-state.ts";

/**
 * The single trailing owner of a session row: passive metadata first, then the
 * one operational state, with management actions overlaying the same cell. It
 * exists so state has exactly one home no matter which list rendered the row.
 */
export function renderSessionRowEndcap(params: {
  state: SessionPrimaryState;
  stateId: string | undefined;
  metadata?: TemplateResult | typeof nothing;
  actions?: TemplateResult | typeof nothing;
}): TemplateResult {
  const state = renderSessionPrimaryState(params.state);
  return html`<span class="sidebar-recent-session__aside session-row-aside">
    ${state === nothing
      ? nothing
      : html`<span
          class="session-row-state"
          id=${params.stateId ?? nothing}
          role="img"
          aria-label=${describeSessionPrimaryState(params.state)}
          >${state}</span
        >`}
    ${params.metadata ?? nothing} ${params.actions ?? nothing}
  </span>`;
}
