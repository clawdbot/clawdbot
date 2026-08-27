import { renderHubTabs } from "../../components/hub-tabs.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";

export function renderSegmented<T extends string>(params: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; testId?: string }>;
  ariaLabel?: string;
  onChange: (value: T) => void;
  /** Render navigation as shared hub tabs instead of a value picker. */
  tabs?: { id: string; panelId: string; variant?: "primary" | "sub" };
}) {
  const tabs = params.tabs;
  if (tabs) {
    return renderHubTabs({
      id: tabs.id,
      active: params.value,
      tabs: params.options.map((option) => ({
        value: option.value,
        label: option.label,
        testId: option.testId,
      })),
      ariaLabel: params.ariaLabel ?? "",
      panelId: tabs.panelId,
      className: "cron-tabs",
      variant: tabs.variant,
      onSelect: params.onChange,
    });
  }
  return renderSettingsSegmented({
    value: params.value,
    options: params.options,
    ariaLabel: params.ariaLabel,
    onChange: (value) => params.onChange(value),
  });
}
