import { describe, expect, it } from "vitest";
import type { ComputerUseV2ActionName } from "../../plugins/computer-use-contract.js";
import { createComputerTool, readActionEnum, v2Descriptor } from "./computer-tool.test-helpers.js";

describe("createComputerTool schema", () => {
  it("keeps an undeclared node on the exact v1 action list", () => {
    expect(readActionEnum(createComputerTool())).toEqual([
      "screenshot",
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "mouse_move",
      "left_click_drag",
      "left_mouse_down",
      "left_mouse_up",
      "scroll",
      "type",
      "key",
      "hold_key",
      "wait",
    ]);
  });

  it("filters the model schema to a preselected v2 descriptor", () => {
    const actions: ComputerUseV2ActionName[] = ["screenshot", "list_apps", "get_window_state"];
    const tool = createComputerTool({ capabilityDescriptor: v2Descriptor(actions) });
    expect(readActionEnum(tool)).toEqual(actions);
  });

  it("advertises resource actions only with an attempt cleanup owner", () => {
    const actions: ComputerUseV2ActionName[] = ["browser_download", "start_recording"];
    expect(
      readActionEnum(createComputerTool({ capabilityDescriptor: v2Descriptor(actions) })),
    ).toEqual([]);
    expect(
      readActionEnum(
        createComputerTool({
          capabilityDescriptor: v2Descriptor(actions),
          registerRunCleanup: () => {},
        }),
      ),
    ).toEqual(actions);
  });

  it("keeps the v2 guidance provider-neutral and free of host setup instructions", () => {
    const tool = createComputerTool({
      capabilityDescriptor: v2Descriptor([
        "screenshot",
        "left_click",
        "list_windows",
        "get_window_state",
        "set_value",
      ]),
    });
    const description = tool.description;

    expect(description).toContain("Observe first with `get_window_state`");
    expect(description).toContain('`effect:"confirmed"` > `unverifiable` > `suspected_noop`');
    expect(description).toContain("never blind-retry a mutation");
    expect(description).toContain("untrusted input");
    expect(description).not.toMatch(
      /cua|peekaboo|\b(?:cli|mcp|daemon|socket|install(?:ation|ing)?)\b|verify_state|start_session|end_session|element_token|snapshot_id|window_id|delivery_mode/iu,
    );
    expect(description.length).toBeLessThan(2_400);
    const schema = JSON.stringify(tool.parameters);
    for (const nativeField of [
      "providerTool",
      "arguments",
      "binaryPath",
      "socketPath",
      "session",
      "driverArgs",
      "output_dir",
      "destinationRoot",
    ]) {
      expect(schema).not.toContain(`"${nativeField}":`);
    }
  });

  it("filters guidance to the selected node's advertised capability families", () => {
    const desktopOnly = createComputerTool({
      capabilityDescriptor: v2Descriptor(["screenshot", "left_click"], {
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
      }),
    }).description;
    expect(desktopOnly).toContain("desktop coordinates from the latest screenshot");
    expect(desktopOnly).toContain("stale frameId");
    expect(desktopOnly).not.toMatch(
      /get_window_state|accessibility|elementRef|window pixels|deliveryMode:"background"|background_unavailable/,
    );

    const windowBackground = createComputerTool({
      capabilityDescriptor: v2Descriptor(
        ["left_click", "list_windows", "get_window_state", "set_value"],
        {
          targets: ["window", "element"],
          deliveryModes: ["background"],
        },
      ),
    }).description;
    expect(windowBackground).toContain(
      "elementRef from the latest observation > window pixels from the latest window image",
    );
    expect(windowBackground).toContain('deliveryMode:"background"');
    expect(windowBackground).toContain("background_occluded");
    expect(windowBackground).not.toMatch(/desktop coordinates|foreground|frameId/);
  });

  it("publishes Codex-compatible fixed-size coordinate arrays", () => {
    const properties = (
      createComputerTool().parameters as {
        properties?: Record<string, Record<string, unknown>>;
      }
    ).properties;

    for (const key of ["coordinate", "startCoordinate"] as const) {
      const schema = properties?.[key];
      if (!schema) {
        throw new Error(`missing ${key} schema`);
      }
      expect(schema).toMatchObject({
        type: "array",
        items: { type: "integer", minimum: 0 },
        minItems: 2,
        maxItems: 2,
      });
      expect(Array.isArray(schema.items)).toBe(false);
      expect(schema).not.toHaveProperty("additionalItems");
    }
  });
});
