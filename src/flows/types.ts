// Shared option/contribution contracts for setup, onboarding, and doctor flow UIs.
type FlowDocsLink = {
  path: string;
  label?: string;
};

type FlowContributionKind = "channel" | "core" | "provider" | "search";

type FlowContributionSurface = "auth-choice" | "health" | "model-picker" | "setup";

type FlowOptionGroup = {
  id: string;
  label: string;
  hint?: string;
};

export type FlowOption<Value extends string = string> = {
  value: Value;
  label: string;
  hint?: string;
  group?: FlowOptionGroup;
  docs?: FlowDocsLink;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
};

/** Generic contribution envelope used by plugin/core setup surfaces. */
export type FlowContribution<Value extends string = string> = {
  id: string;
  kind: FlowContributionKind;
  surface: FlowContributionSurface;
  option: FlowOption<Value>;
  source?: string;
};

/** Sorts UI flow contributions deterministically by visible label, then value. */
export function sortFlowContributionsByLabel<T extends FlowContribution>(
  contributions: readonly T[],
): T[] {
  return [...contributions].toSorted(
    (left, right) =>
      left.option.label.localeCompare(right.option.label) ||
      left.option.value.localeCompare(right.option.value),
  );
}
