// Navigation prompt tests cover shared onboarding footer copy through the prompt renderer.
import type { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";

type TestPromptOption = {
  value: unknown;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

type TestSelectPrompt = {
  state: "active";
  cursor: number;
  options: TestPromptOption[];
};

vi.mock("@clack/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/core")>();
  return {
    ...actual,
    SelectPrompt: class {
      readonly state = "active" as const;
      readonly cursor = 0;
      readonly options: TestPromptOption[];
      readonly render: () => string;

      constructor(params: {
        options: TestPromptOption[];
        render: (this: TestSelectPrompt) => string;
      }) {
        this.options = params.options;
        this.render = params.render.bind(this);
      }

      prompt(): Promise<string> {
        return Promise.resolve(this.render());
      }
    },
  };
});

import { selectWithNavigationFooter } from "./clack-navigation-prompts.js";
import type { WizardPromptNavigation } from "./prompts.js";

const output = {
  columns: 80,
  write: () => true,
} as unknown as Writable;

async function renderNavigationFooter(
  navigation: WizardPromptNavigation | undefined,
): Promise<string> {
  return stripAnsi(
    String(
      await selectWithNavigationFooter({
        message: "Pick one",
        options: [{ value: "one", label: "One" }],
        navigation,
        output,
      }),
    ),
  );
}

describe("navigation-aware select rendering", () => {
  it("omits navigation copy when no move is available", async () => {
    await expect(
      renderNavigationFooter({ canGoBack: false, canGoForward: false }),
    ).resolves.not.toMatch(/← back|→ next/u);
  });

  it("renders compact back and forward guidance", async () => {
    await expect(
      renderNavigationFooter({ canGoBack: true, canGoForward: true }),
    ).resolves.toContain("← back  → next  ↑/↓ option");
  });

  it("renders only the available navigation action", async () => {
    await expect(
      renderNavigationFooter({ canGoBack: true, canGoForward: false }),
    ).resolves.toContain("← back  ↑/↓ option");
    await expect(
      renderNavigationFooter({ canGoBack: false, canGoForward: true }),
    ).resolves.toContain("→ next  ↑/↓ option");
  });
});
