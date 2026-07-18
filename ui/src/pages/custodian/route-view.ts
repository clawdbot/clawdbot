import { html } from "lit";
import type { CustodianRouteData } from "./route.ts";

export function renderCustodianRoute(data: CustodianRouteData | undefined) {
  return html`
    <openclaw-custodian-page .onboarding=${data?.onboarding === true}></openclaw-custodian-page>
  `;
}
