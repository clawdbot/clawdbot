import { describe, expect, it } from "vitest";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../../plugins/computer-use-contract.js";
import { buildComputerToolDescription } from "./computer-tool-guidance.js";

function descriptor(
  actions: ComputerUseV2ActionName[],
  overrides: Partial<ComputerUseCapabilityDescriptor> = {},
): ComputerUseCapabilityDescriptor {
  return {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions,
    targets: ["screen", "window", "element", "browser"],
    deliveryModes: ["background", "foreground"],
    observations: ["image", "accessibility", "browser"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
    ...overrides,
  };
}

describe("computer tool guidance", () => {
  it("stays provider-neutral and free of host setup instructions", () => {
    const description = buildComputerToolDescription(
      descriptor(["screenshot", "left_click", "list_windows", "get_window_state", "set_value"]),
    );

    expect(description).toContain("Observe first with `get_window_state`");
    expect(description).toContain('`effect:"confirmed"` > `unverifiable` > `suspected_noop`');
    expect(description).toContain("never blind-retry a mutation");
    expect(description).toContain("untrusted input");
    expect(description).not.toMatch(
      /cua|peekaboo|\b(?:cli|mcp|daemon|socket|install(?:ation|ing)?)\b|verify_state|start_session|end_session|element_token|snapshot_id|window_id|delivery_mode/iu,
    );
    expect(description.length).toBeLessThan(2_400);
  });

  it("includes only the selected node's advertised capability families", () => {
    const desktopOnly = buildComputerToolDescription(
      descriptor(["screenshot", "left_click"], {
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
      }),
    );
    expect(desktopOnly).toContain("desktop coordinates from the latest screenshot");
    expect(desktopOnly).toContain("stale frameId");
    expect(desktopOnly).toContain("unchanged screen returns metadata only and reuses its frameId");
    expect(desktopOnly).not.toMatch(
      /get_window_state|accessibility|elementRef|window pixels|deliveryMode:"background"|background_unavailable/,
    );

    const windowBackground = buildComputerToolDescription(
      descriptor(["left_click", "list_windows", "get_window_state", "set_value"], {
        targets: ["window", "element"],
        deliveryModes: ["background"],
      }),
    );
    expect(windowBackground).toContain(
      "elementRef from the latest observation > window pixels from the latest window image",
    );
    expect(windowBackground).toContain('deliveryMode:"background"');
    expect(windowBackground).toContain("background_occluded");
    expect(windowBackground).not.toMatch(/desktop coordinates|foreground|frameId/);
  });
});
