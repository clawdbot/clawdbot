import { describe, expect, it } from "vitest";
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

  it.each([
    ["an existing wait", ["screenshot", "wait"]],
    ["no screenshot", ["list_windows"]],
  ] as const)("preserves the effective action list with %s", (_name, actions) => {
    const tool = createComputerTool({
      transport: {
        computerUse: v2Descriptor([...actions]),
        resolveNode: async () => ({ nodeId: "session-desktop" }),
        invoke: async () => undefined,
      },
    });
    expect(readActionEnum(tool)).toEqual(actions);
  });

  it("keeps model input free of native provider fields", () => {
    const schema = JSON.stringify(createComputerTool().parameters);
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
