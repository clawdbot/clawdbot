import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelActiveRouteTransition } from "./route-transition-owner.ts";
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
  it("keeps the outgoing view live until the destination is prepared", async () => {
    let finishPreparation!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const navigate = vi.fn(async () => undefined);
    const test = testDocumentWithOutlet();
    const transition = navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prepare,
      prefersReducedMotion: false,
    });
    await Promise.resolve();

    expect(prepare).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();

    finishPreparation();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await transition;

    expect(navigate).toHaveBeenCalledOnce();
  });

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
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
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

  it("navigates directly when destination preparation fails", async () => {
    const test = testDocumentWithOutlet();
    const navigate = vi.fn(async () => undefined);

    await navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prepare: async () => {
        throw new Error("preload failed");
      },
      prefersReducedMotion: false,
    });

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

  it("settles without animating when browser navigation supersedes a pending chat route", async () => {
    const test = testDocumentWithOutlet();
    const navigate = vi.fn(async () => undefined);
    const transition = navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: false,
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    let settled = false;
    void transition.then(() => {
      settled = true;
    });

    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(settled).toBe(true));
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));

    expect(test.animate).not.toHaveBeenCalled();
  });

  it("cancels an active route animation when another destination takes ownership", async () => {
    const finished = new Promise<Animation>(() => {});
    const cancel = vi.fn();
    const animation = { finished } as Animation;
    animation.cancel = cancel;
    const test = testDocumentWithOutlet(vi.fn(() => animation));
    const navigate = vi.fn(async () => undefined);
    const transition = navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: false,
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await vi.waitFor(() => expect(test.animate).toHaveBeenCalledOnce());

    cancelActiveRouteTransition(document, { routeId: "about", mode: "push" });
    await transition;

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("honors a different route requested while transition navigation starts", async () => {
    const test = testDocumentWithOutlet();
    const navigate = vi.fn(async () => {
      cancelActiveRouteTransition(document, { routeId: "about", mode: "push" });
    });

    await navigateWithRouteTransition({
      document: test.document,
      from: "new-session",
      to: "chat",
      navigate,
      prefersReducedMotion: false,
    });

    expect(navigate).toHaveBeenCalledOnce();
    expect(test.animate).not.toHaveBeenCalled();
  });

  it("allows same-target replacements while the chat route finishes rendering", async () => {
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
    let settled = false;
    void transition.then(() => {
      settled = true;
    });

    cancelActiveRouteTransition(document, { routeId: "chat", mode: "replace" });
    await Promise.resolve();
    expect(settled).toBe(false);

    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await transition;
    expect(test.animate).not.toHaveBeenCalled();
  });

  it("cancels a preparing transition when a newer transition takes ownership", async () => {
    let finishPreparation!: () => void;
    const firstNavigate = vi.fn(async () => undefined);
    const first = navigateWithRouteTransition({
      document,
      from: "new-session",
      to: "chat",
      prepare: () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
      navigate: firstNavigate,
      prefersReducedMotion: false,
    });
    await Promise.resolve();

    const secondNavigate = vi.fn(async () => undefined);
    const second = navigateWithRouteTransition({
      document,
      from: "new-session",
      to: "chat",
      navigate: secondNavigate,
      prefersReducedMotion: true,
    });
    await vi.waitFor(() => expect(secondNavigate).toHaveBeenCalledOnce());
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await second;
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await vi.waitFor(() => expect(firstSettled).toBe(true));

    finishPreparation();
    await Promise.resolve();
    expect(firstNavigate).not.toHaveBeenCalled();
  });
});
