import type { WizardAnswer } from "@openclaw/gateway-protocol";
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import type { WizardStep } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayCapabilityAdvertised } from "../../lib/gateway-methods.ts";

type CustodianWizardSubmission = {
  answer: WizardAnswer;
  display: string;
};

function findOption(step: WizardStep, value: unknown) {
  return step.options?.find((option) => Object.is(option.value, value));
}

/** Build the typed answer sent by a client rendering the current wizard step. */
export function custodianWizardSubmission(
  step: WizardStep,
  value: unknown,
): CustodianWizardSubmission | null {
  if (step.type === "note" || step.type === "action" || step.type === "progress") {
    return { answer: { stepId: step.id }, display: t("common.continue") };
  }
  if (step.type === "text") {
    return typeof value === "string"
      ? { answer: { stepId: step.id, value }, display: value }
      : null;
  }
  if (step.type === "confirm") {
    if (typeof value !== "boolean") {
      return null;
    }
    return {
      answer: { stepId: step.id, value },
      display: t(value ? "common.yes" : "common.no"),
    };
  }
  if (step.type === "select") {
    const option = findOption(step, value);
    return option ? { answer: { stepId: step.id, value }, display: option.label } : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return { answer: { stepId: step.id, value: [] }, display: t("common.none") };
  }
  const labels = value.map((entry) => findOption(step, entry)?.label);
  if (!labels.every((label): label is string => label !== undefined)) {
    return null;
  }
  return {
    answer: { stepId: step.id, value },
    display: labels.join(", "),
  };
}

export function initialCustodianWizardValue(step: WizardStep): unknown {
  return step.type === "multiselect"
    ? Array.isArray(step.initialValue)
      ? [...step.initialValue]
      : []
    : step.initialValue;
}

export function isCustodianWizardCancelAvailable(context: ApplicationContext | null): boolean {
  return (
    isGatewayCapabilityAdvertised(
      context?.gateway.snapshot ?? {},
      GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
    ) ?? false
  );
}
