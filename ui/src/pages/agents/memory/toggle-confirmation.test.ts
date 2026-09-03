/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDreamingToggleConfirmation } from "./toggle-confirmation.ts";

type ToggleProps = Parameters<typeof renderDreamingToggleConfirmation>[0];

function renderToggle(overrides?: Partial<ToggleProps>): HTMLElement {
  const props: ToggleProps = {
    open: true,
    enabling: true,
    loading: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    hasError: false,
    ...overrides,
  };
  const host = document.createElement("div");
  render(renderDreamingToggleConfirmation(props), host);
  return host;
}

describe("renderDreamingToggleConfirmation", () => {
  it("renders nothing while closed", () => {
    expect(renderToggle({ open: false }).textContent?.trim()).toBe("");
  });

  it("states the per-agent scope and never promises a gateway restart", () => {
    for (const enabling of [true, false]) {
      const text = renderToggle({ enabling }).textContent ?? "";
      expect(text).toContain("This Agent");
      expect(text).toContain("selected agent");
      expect(text.toLowerCase()).toContain("other agents are unchanged");
      expect(text.toLowerCase()).not.toContain("restart");
      expect(text.toLowerCase()).not.toContain("interrupt");
    }
  });

  it("uses direction-specific copy for enabling and disabling", () => {
    expect(renderToggle({ enabling: true }).textContent).toContain(
      "Include This Agent in Dreaming",
    );
    expect(renderToggle({ enabling: true }).textContent).toContain("Include Agent");
    const disabling = renderToggle({ enabling: false });
    expect(disabling.textContent).toContain("Exclude This Agent from Dreaming");
    expect(disabling.textContent).toContain("Exclude Agent");
    // Disabling is the destructive direction: it stops automatic Dreaming for this agent.
    expect(disabling.querySelector("button.btn.danger")).not.toBeNull();
    expect(renderToggle({ enabling: true }).querySelector("button.btn.danger")).toBeNull();
  });

  it("swaps the confirm label for a saving label while the write is in flight", () => {
    const host = renderToggle({ loading: true });
    const confirm = host.querySelector("button");
    expect(confirm?.textContent?.trim()).toBe("Saving…");
    expect(confirm?.hasAttribute("disabled")).toBe(true);
  });

  it("ignores backdrop cancel while saving", () => {
    const onCancel = vi.fn();
    const host = renderToggle({ loading: true, onCancel });
    host.querySelector("openclaw-modal-dialog")?.dispatchEvent(new CustomEvent("modal-cancel"));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
