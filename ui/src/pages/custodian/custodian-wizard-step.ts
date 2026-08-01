import type { WizardStep } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

type CustodianWizardReply = {
  message: string;
  display: string;
};

function findOptionIndex(step: WizardStep, value: unknown): number {
  return (step.options ?? []).findIndex((option) => Object.is(option.value, value));
}

/** Translate rich controls back into the text grammar consumed by the hosted chat wizard. */
export function custodianWizardReply(
  step: WizardStep,
  value: unknown,
  includeValue = true,
): CustodianWizardReply | null {
  if (!includeValue || step.type === "note" || step.type === "action" || step.type === "progress") {
    return { message: "continue", display: t("common.continue") };
  }
  if (step.type === "text") {
    return typeof value === "string" ? { message: value, display: value } : null;
  }
  if (step.type === "confirm") {
    if (typeof value !== "boolean") {
      return null;
    }
    return {
      message: value ? "yes" : "no",
      display: t(value ? "common.yes" : "common.no"),
    };
  }
  if (step.type === "select") {
    const index = findOptionIndex(step, value);
    const option = step.options?.[index];
    return index >= 0 && option ? { message: String(index + 1), display: option.label } : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return { message: "none", display: t("common.none") };
  }
  const indexes = value.map((entry) => findOptionIndex(step, entry));
  if (indexes.some((index) => index < 0)) {
    return null;
  }
  return {
    message: indexes.map((index) => String(index + 1)).join(","),
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
