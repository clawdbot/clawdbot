import { describe, expect, it } from "vitest";
import {
  clearSessionPanelToggle,
  rememberSessionPanelToggle,
  takeSessionPanelToggle,
} from "./session-panel-toggle-buffer.ts";

describe("session panel toggle buffer", () => {
  it("keeps an early route-startup intent until the pane claims it", () => {
    const event = new CustomEvent("openclaw:desktop-toggle", {
      detail: { open: true, environmentId: "worker-desktop-1" },
    });
    rememberSessionPanelToggle("desktop", event);

    expect(takeSessionPanelToggle("desktop")).toBe(event);
    expect(takeSessionPanelToggle("desktop")).toBeNull();
  });

  it("does not let an older direct delivery clear a newer intent", () => {
    const older = new Event("openclaw:browser-toggle");
    const newer = new Event("openclaw:browser-toggle");
    rememberSessionPanelToggle("browser", older);
    rememberSessionPanelToggle("browser", newer);

    clearSessionPanelToggle("browser", older);

    expect(takeSessionPanelToggle("browser")).toBe(newer);
  });
});
