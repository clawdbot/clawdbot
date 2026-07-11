// Control UI browser tests cover About layout behavior.
import { nothing, render } from "lit";
import { describe, expect, it } from "vitest";
import "../../styles.css";
import { renderAbout } from "./view.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("About responsive browser layout", () => {
  it("keeps the desktop build identity in one row without horizontal overflow", async () => {
    const container = document.createElement("div");
    container.style.width = "760px";
    container.style.setProperty("--control-ui-text-scale", "2");
    document.body.append(container);
    try {
      render(
        renderAbout({
          buildInfo: {
            version: "2026.7.10",
            commit: COMMIT,
            builtAt: "2026-07-10T12:34:56.000Z",
            branch: "feature/build-chip",
            dirty: false,
            buildId: "test",
          },
          gatewayVersion: "2026.7.9",
          copyState: "idle",
          onCopyCommit: () => undefined,
        }),
        container,
      );
      await nextFrame();

      const strip = container.querySelector<HTMLElement>(".about-build-strip");
      const items = Array.from(container.querySelectorAll<HTMLElement>(".about-build-strip__item"));
      expect(strip).not.toBeNull();
      expect(new Set(items.map((item) => item.offsetTop)).size).toBe(1);
      expect((strip?.scrollWidth ?? 1) - (strip?.clientWidth ?? 0)).toBeLessThanOrEqual(1);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });
});
