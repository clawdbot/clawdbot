import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_ROUTE_READY_EVENT, navigateWithRouteTransition } from "./route-transition.ts";

function testDocumentWithOutlet(animate = vi.fn()) {
  const outlet = document.createElement("openclaw-router-outlet") as HTMLElement & {
    updateComplete: Promise<void>;
  };
  // Own data property: the real OpenClawRouterOutlet may already be registered by a
  // sibling test in this worker, and Lit's updateComplete is a getter-only accessor.
  Object.defineProperty(outlet, "updateComplete", {
    value: Promise.resolve(),
    configurable: true,
  });
  outlet.animate = animate;
  document.body.append(outlet);
  return {
    animate,
    document,
    outlet,
  };
}

afterEach(() => document.body.replaceChildren());

describe("navigateWithRouteTransition", () => {
  it("animates the rendered chat pane without freezing the outgoing document", async () => {
    const finished = Promise.resolve({} as Animation);
    const animate = vi.fn(() => ({ finished }) as Animation);
    const test = testDocumentWithOutlet(animate);
    let finishNavigation!: () => void;
    const navigate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );

    const transition = navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: false,
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();
    finishNavigation();
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await transition;

    expect(navigate).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translateY(5px) scale(0.997)" }, { transform: "none" }],
      { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  });

  it("propagates navigation failure without animating", async () => {
    const test = testDocumentWithOutlet();
    const failure = new Error("Chat route failed to load");
    const navigate = vi.fn(async () => {
      throw failure;
    });

    await expect(
      navigateWithRouteTransition({
        document: test.document,
        from: "new-session",
        to: "chat",
        navigate,
        prefersReducedMotion: false,
      }),
    ).rejects.toBe(failure);

    expect(navigate).toHaveBeenCalledOnce();
    expect(test.animate).not.toHaveBeenCalled();
  });

  it.each([
    { from: "about" as const, to: "chat" as const, prefersReducedMotion: false },
    { from: "new-session" as const, to: "about" as const, prefersReducedMotion: false },
  ])("navigates directly for $from to $to", async ({ from, to, prefersReducedMotion }) => {
    const test = testDocumentWithOutlet();
    const navigate = vi.fn(async () => undefined);

    await navigateWithRouteTransition({
      document: test.document,
      from,
      to,
      navigate,
      prefersReducedMotion,
    });

    expect(navigate).toHaveBeenCalledOnce();
    expect(test.animate).not.toHaveBeenCalled();
  });

  it("waits for the chat route without animating when motion is reduced", async () => {
    const test = testDocumentWithOutlet();
    const navigate = vi.fn(async () => undefined);
    const transition = navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: true,
    });

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await transition;

    expect(test.animate).not.toHaveBeenCalled();
  });
});
