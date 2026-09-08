import { afterEach } from "vitest";
import type { SelectPicker } from "../components/select-picker.ts";

const mounted = new Set<HTMLElement>();
afterEach(() => {
  for (const container of mounted) {
    container.remove();
  }
  mounted.clear();
});

export async function updatePickers(container: HTMLElement) {
  if (!container.isConnected) {
    document.body.append(container);
    mounted.add(container);
  }
  await Promise.all(
    [...container.querySelectorAll<SelectPicker>("openclaw-select-picker")].map(
      (picker) => picker.updateComplete,
    ),
  );
}

export async function choosePickerValue(element: HTMLElement, value: string) {
  const picker = element.closest<SelectPicker>("openclaw-select-picker");
  if (!picker) {
    throw new Error("Picker owner is missing");
  }
  await picker.updateComplete;
  const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger");
  if (!trigger) {
    throw new Error("Picker trigger is missing");
  }
  if (trigger.getAttribute("aria-expanded") !== "true") {
    trigger.click();
  }
  await picker.updateComplete;
  const row = [...picker.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.dataset.value === value,
  );
  if (!row) {
    throw new Error(`Picker option is missing: ${value}`);
  }
  row.click();
  await picker.updateComplete;
}
