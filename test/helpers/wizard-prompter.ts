// Wizard prompter test helper provides mocked wizard prompt responses.
import { vi } from "vitest";
import type { WizardPrompter, WizardSelectParams } from "../../src/wizard/prompts.js";

// Vitest mock prompter for wizard tests.

/** Create a WizardPrompter with default mocked responses and optional overrides. */
export function createWizardPrompter(
  overrides?: Partial<WizardPrompter>,
  options?: { defaultSelect?: string; selectValues?: string[] },
): WizardPrompter {
  const selectValues = [...(options?.selectValues ?? [])];
  const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
    // Consent is a distinct boolean choice; flow-answer queues remain reserved for setup modes.
    if (
      params.initialValue === false &&
      params.options.some((option) => option.value === false) &&
      params.options.some((option) => option.value === true)
    ) {
      return false;
    }
    return selectValues.shift() ?? options?.defaultSelect ?? "quickstart";
  }) as unknown as WizardPrompter["select"];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select,
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}
