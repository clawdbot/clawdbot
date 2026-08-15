/**
 * Test doubles for setup and command prompt tests.
 *
 * These helpers provide typed RuntimeEnv and WizardPrompter mocks that fail
 * fast when command code calls exit.
 */
import { vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";

/** Creates a RuntimeEnv mock with exit throwing for assertion-friendly tests. */
export const makeRuntime = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as RuntimeEnv["exit"],
  ...overrides,
});

/** Creates a WizardPrompter mock with inert defaults for prompt-heavy tests. */
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
