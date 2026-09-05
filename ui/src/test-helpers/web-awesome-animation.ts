import { expect } from "vitest";

// Hold a real CSS animation at an active sample: delayed animationstart events
// can arrive after native completion has already removed the animation class.
export async function duringElementAnimation(
  element: HTMLElement,
  state: "show" | "hide" | "show-with-scale",
  request: () => unknown,
  action: () => void | Promise<void>,
) {
  const playState = element.style.animationPlayState;
  let animation: CSSAnimation | undefined;
  let playbackRate: number | undefined;
  element.style.animationPlayState = "paused";
  try {
    await request();
    await expect
      .poll(() => {
        animation = element.classList.contains(state)
          ? element.getAnimations().find((entry) => entry instanceof CSSAnimation)
          : undefined;
        return animation;
      })
      .toBeDefined();
    const active = animation!;
    playbackRate = active.playbackRate;
    await active.ready;
    expect(active.playState).toBe("paused");
    const { activeDuration } = active.effect!.getComputedTiming();
    expect(activeDuration).toBeGreaterThan(0);
    expect(Number.isFinite(activeDuration)).toBe(true);
    active.currentTime = Number(activeDuration) / 2;
    // Zero rate keeps native playState running without advancing the sample.
    active.playbackRate = 0;
    active.play();
    await active.ready;
    expect(active.pending).toBe(false);
    expect(active.playState).toBe("running");
    const { progress } = active.effect!.getComputedTiming();
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
    await action();
  } finally {
    element.style.animationPlayState = playState;
    if (animation && playbackRate !== undefined) {
      animation.playbackRate = playbackRate;
    }
  }
}
