/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast } from "./toast.ts";

async function mountHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("shared toast", () => {
  it("shows and replaces the active toast", async () => {
    const host = await mountHost();

    showToast({ message: "First" });
    await host.updateComplete;
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("First");

    showToast({ message: "Second" });
    await host.updateComplete;
    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Second");
  });

  it("auto-dismisses after the configured duration", async () => {
    vi.useFakeTimers();
    const host = await mountHost();

    showToast({ message: "Temporary", durationMs: 50 });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await host.updateComplete;

    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("runs its action once and dismisses", async () => {
    const host = await mountHost();
    const onAction = vi.fn();
    showToast({ message: "Archived", actionLabel: "Undo", onAction });
    await host.updateComplete;

    host.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await host.updateComplete;

    expect(onAction).toHaveBeenCalledOnce();
    expect(host.querySelector(".app-toast")).toBeNull();
  });
});
