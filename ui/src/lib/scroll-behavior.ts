export function resolveScrollBehavior(behavior: ScrollBehavior = "smooth"): ScrollBehavior {
  return behavior === "smooth" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : behavior;
}
