// The shared picker keeps a 138px readable-label floor (phone-width ellipsis
// fix) but must never exceed its host container: cron/channel grid cells
// legitimately shrink below 138px and an unconditional floor overflows them.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderPicker } from "./select-picker.ts";

describe("renderPicker", () => {
  it("renders optional label styles and invokes the lazy-open hook", () => {
    const host = document.createElement("div");
    const onOpen = vi.fn();
    render(
      renderPicker({
        label: "Style",
        value: "plain",
        options: [
          { value: "plain", label: "Plain" },
          { value: "styled", label: "Styled", labelStyle: "font-family: Georgia" },
        ],
        onOpen,
        onChange: () => {},
      }),
      host,
    );
    const labels = host.querySelectorAll<HTMLElement>(".picker-select__label");
    expect(labels[0]?.hasAttribute("style")).toBe(false);
    expect(labels[1]?.style.fontFamily).toBe("Georgia");
    expect(onOpen).not.toHaveBeenCalled();
    host.querySelector("wa-select")?.dispatchEvent(new Event("wa-show"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it("caps the readable-label floor at the host container width", () => {
    const host = document.createElement("div");
    render(
      renderPicker({
        label: "Unit",
        value: "minutes",
        options: [{ value: "minutes", label: "minutes" }],
        onChange: () => {},
      }),
      host,
    );
    const select = host.querySelector("wa-select");
    expect(select?.getAttribute("style")).toContain("min-width:min(138px,100%)");
  });
});
