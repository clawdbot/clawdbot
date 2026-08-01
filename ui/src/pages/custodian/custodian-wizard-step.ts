import type { WizardAnswer } from "@openclaw/gateway-protocol";
import type { WizardStep } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

type CustodianWizardSubmission = {
  answer: WizardAnswer;
  display: string;
};

function findOptionIndex(step: WizardStep, value: unknown): number {
  return (step.options ?? []).findIndex((option) => Object.is(option.value, value));
}

/** Build the typed answer sent by a client rendering the current wizard step. */
export function custodianWizardSubmission(
  step: WizardStep,
  value: unknown,
  includeValue = true,
): CustodianWizardSubmission | null {
  if (!includeValue || step.type === "note" || step.type === "action" || step.type === "progress") {
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
    const index = findOptionIndex(step, value);
    const option = step.options?.[index];
    return index >= 0 && option
      ? { answer: { stepId: step.id, value }, display: option.label }
      : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return { answer: { stepId: step.id, value: [] }, display: t("common.none") };
  }
  const indexes = value.map((entry) => findOptionIndex(step, entry));
  if (indexes.some((index) => index < 0)) {
    return null;
  }
  return {
    answer: { stepId: step.id, value },
    display: indexes.map((index) => step.options?.[index]?.label ?? "").join(", "),
  };
}

export function initialCustodianWizardValue(step: WizardStep): unknown {
  return step.type === "multiselect"
    ? Array.isArray(step.initialValue)
      ? [...step.initialValue]
      : []
    : step.initialValue;
}
