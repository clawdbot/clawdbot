import { html, nothing } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { hasNativeUpdateBridge } from "../../app/native-link-routing.ts";
import {
  confirmAndStartUpdate,
  createUpdateProgressWatcher,
} from "../../app/update-confirmation.ts";
import type {
  CustodianAlert,
  CustodianAlertAction,
} from "../../components/custodian-alert-contract.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";

function runAlertAction(
  target: CustodianAlertAction,
  context: ApplicationContext,
  canUpdate: boolean,
): void {
  if (target.kind === "navigate") {
    context.navigate(target.routeId);
  } else if (canUpdate) {
    void confirmAndStartUpdate({
      startGatewayUpdate: () => void context.overlays.runUpdate(),
      watchUpdateProgress: createUpdateProgressWatcher(context),
      updateAvailable: context.overlays.snapshot.updateAvailable,
      updateSchedule: context.overlays.snapshot.updateSchedule,
      viaNativeApp: hasNativeUpdateBridge(),
    });
  }
}

export function renderCustodianAlertCard(params: {
  alert: CustodianAlert;
  context: ApplicationContext;
  onDismiss: () => void;
}) {
  const { action } = params.alert;
  const canUpdate = canCallGatewayMethod(
    params.context.gateway.snapshot,
    "update.run",
    "operator.admin",
  );
  const updateDisabled = action?.target.kind === "update" && !canUpdate;
  return html`<article class="custodian__nudge custodian__alert-card" role="status">
    <div class="custodian__alert-heading">
      <strong>${params.alert.title}</strong>
      <button
        class="custodian__nudge-dismiss"
        type="button"
        aria-label=${t("common.dismiss")}
        @click=${params.onDismiss}
      >
        ×
      </button>
    </div>
    <ul class="custodian__alert-facts">
      ${params.alert.facts.map((fact) => html`<li>${fact}</li>`)}
    </ul>
    ${
      action
        ? html`<button
            class="btn btn--sm primary custodian__alert-action"
            type="button"
            title=${updateDisabled ? t("updates.adminRequired") : nothing}
            ?disabled=${updateDisabled}
            @click=${() => runAlertAction(action.target, params.context, canUpdate)}
          >
            ${action.label}
          </button>`
        : nothing
    }
  </article>`;
}
