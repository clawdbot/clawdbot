/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import "./dashboard-preview.ts";

type DashboardPreviewElement = HTMLElement & {
  error: string | null;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("resumes near-viewport rendering after being detached and reattached", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const element = document.createElement("openclaw-dashboard-preview") as DashboardPreviewElement;
  element.error = "Preview unavailable";

  document.body.append(element);
  frames.shift()?.(0);
  await element.updateComplete;
  expect(element.textContent).toContain("Preview unavailable");

  element.remove();
  await element.updateComplete;
  expect(element.textContent).not.toContain("Preview unavailable");

  document.body.append(element);
  frames.shift()?.(0);
  await element.updateComplete;
  expect(element.textContent).toContain("Preview unavailable");
});
