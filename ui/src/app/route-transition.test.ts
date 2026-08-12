import { describe, expect, it, vi } from "vitest";
import { navigateWithRouteTransition } from "./route-transition.ts";

describe("navigateWithRouteTransition", () => {
  it("keeps the outgoing view live until the destination is prepared", async () => {
    let finishPreparation!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const navigate = vi.fn(async () => undefined);
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      return { finished: Promise.resolve(update()).then(() => undefined) };
    });
    const testDocument = {
      documentElement: document.documentElement,
      querySelector: () => null,
      startViewTransition,
    } as unknown as Document & { startViewTransition: typeof startViewTransition };

    const transition = navigateWithRouteTransition({
      document: testDocument,
      from: "new-session",
      to: "chat",
      navigate,
      prepare,
      prefersReducedMotion: false,
    });
    await Promise.resolve();

    expect(prepare).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    finishPreparation();
    await transition;

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("crossfades the new-session route into chat", async () => {
    const navigate = vi.fn(async () => undefined);
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      return { finished: Promise.resolve(update()).then(() => undefined) };
    });
    const outlet = document.createElement("openclaw-router-outlet") as HTMLElement & {
      updateComplete: Promise<void>;
    };
    outlet.updateComplete = Promise.resolve();
    const testDocument = {
      documentElement: document.documentElement,
      querySelector: () => outlet,
      startViewTransition,
    } as unknown as Document & { startViewTransition: typeof startViewTransition };

    await navigateWithRouteTransition({
      document: testDocument,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: false,
    });

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("session-route-transition")).toBe(false);
  });

  it("falls back to direct navigation when the browser declines the transition", async () => {
    const navigate = vi.fn(async () => undefined);
    const startViewTransition = vi.fn(() => {
      throw new Error("transition unavailable");
    });
    const testDocument = {
      documentElement: document.documentElement,
      startViewTransition,
    } as unknown as Document & { startViewTransition: typeof startViewTransition };

    await navigateWithRouteTransition({
      document: testDocument,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: false,
    });

    expect(navigate).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("session-route-transition")).toBe(false);
  });

  it("navigates directly when destination preparation fails", async () => {
    const navigate = vi.fn(async () => undefined);
    const startViewTransition = vi.fn();
    const testDocument = {
      documentElement: document.documentElement,
      startViewTransition,
    } as unknown as Document & { startViewTransition: typeof startViewTransition };

    await navigateWithRouteTransition({
      document: testDocument,
      from: "new-session",
      to: "chat",
      navigate,
      prepare: async () => {
        throw new Error("preload failed");
      },
      prefersReducedMotion: false,
    });

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it.each([
    { from: "about" as const, to: "chat" as const, prefersReducedMotion: false },
    { from: "new-session" as const, to: "about" as const, prefersReducedMotion: false },
    { from: "new-session" as const, to: "chat" as const, prefersReducedMotion: true },
  ])("navigates directly for $from to $to", async ({ from, to, prefersReducedMotion }) => {
    const navigate = vi.fn(async () => undefined);
    const startViewTransition = vi.fn();
    const testDocument = {
      documentElement: document.documentElement,
      startViewTransition,
    } as unknown as Document & { startViewTransition: typeof startViewTransition };

    await navigateWithRouteTransition({
      document: testDocument,
      from,
      to,
      navigate,
      prefersReducedMotion,
    });

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
