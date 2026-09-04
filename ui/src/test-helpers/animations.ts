// Evaluate on the animated element inside its shadow root; document/host
// animation queries do not reach Web Awesome's nested popup or dialog.
export function finishElementAnimations(element: Element): void {
  for (const animation of element.getAnimations({ subtree: true })) {
    // Finish layout transitions without waiting on headless renderer clocks,
    // but leave perpetual activity indicators running.
    if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
      animation.finish();
    }
  }
}
