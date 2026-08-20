// The shared picker keeps a 138px readable-label floor (phone-width ellipsis
// fix) but must never exceed its host container: cron/channel grid cells
// legitimately shrink below 138px and an unconditional floor overflows them.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderPicker } from "./select-picker.ts";

describe("renderPicker", () => {
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
