import type { Locator } from "playwright";

export function modelPickerValue(locator: Locator) {
  return locator.evaluate((element) => String((element as HTMLElement & { value?: string }).value));
}

export async function selectModelPicker(locator: Locator, value: string) {
  await locator.evaluate(async (element, next) => {
    const select = element as HTMLElement & { value: string; updateComplete: Promise<unknown> };
    select.value = next;
    await select.updateComplete;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
