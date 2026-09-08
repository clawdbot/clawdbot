import type { Locator } from "playwright";

export function pickerValue(picker: Locator) {
  return picker.locator('[role="option"][aria-selected="true"]').getAttribute("data-value");
}

export async function openPicker(picker: Locator) {
  const trigger = picker.locator(".picker-select__trigger");
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await trigger.click();
  }
  await picker.getByRole("listbox").waitFor({ state: "visible" });
}

export async function selectPickerValue(picker: Locator, value: string) {
  await openPicker(picker);
  await picker.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}
