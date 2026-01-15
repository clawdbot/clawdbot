import { vi } from "vitest";

import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";

export const makeRuntime = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as RuntimeEnv["exit"],
  ...overrides,
});

export const makePrompter = (overrides: Partial<WizardPrompter> = {}): WizardPrompter => ({
  intro: vi.fn(async () => {}),
  outro: vi.fn(async () => {}),
  note: vi.fn(async () => {}),
  select: vi.fn(async () => "npm") as WizardPrompter["select"],
  multiselect: vi.fn(async () => []) as WizardPrompter["multiselect"],
  text: vi.fn(async () => "") as WizardPrompter["text"],
  confirm: vi.fn(async () => false),
  progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  ...overrides,
});
