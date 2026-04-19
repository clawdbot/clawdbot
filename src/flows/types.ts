export type FlowDocsLink = {
  path: string;
  label?: string;
};

export type FlowContributionKind = "channel" | "core" | "provider" | "search";

export type FlowContributionSurface = "auth-choice" | "health" | "model-picker" | "setup";

export type FlowOptionGroup = {
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

export type FlowContribution<Value extends string = string> = {
  id: string;
  kind: FlowContributionKind;
  surface: FlowContributionSurface;
  option: FlowOption<Value>;
  source?: string;
};

export function sortFlowContributionsByLabel<T extends FlowContribution>(
  contributions: readonly T[],
): T[] {
  return [...contributions].toSorted(
    (left, right) =>
      left.option.label.localeCompare(right.option.label) ||
      left.option.value.localeCompare(right.option.value),
  );
}
