// Android node required-command tests cover live capability suite gating.
import { describe, expect, it } from "vitest";
import {
  ANDROID_NODE_REQUIRED_NON_INTERACTIVE_COMMANDS,
  findMissingRequiredAndroidNodeCommands,
} from "../../test/helpers/gateway/android-node-capabilities-required-commands.js";

describe("findMissingRequiredAndroidNodeCommands", () => {
  it("keeps the mandatory baseline to core node health and introspection commands", () => {
    expect([...ANDROID_NODE_REQUIRED_NON_INTERACTIVE_COMMANDS]).toEqual([
      "device.health",
      "device.info",
      "device.permissions",
      "device.status",
    ]);
  });

  it("reports required commands that are not runnable after policy filtering", () => {
    expect(
      findMissingRequiredAndroidNodeCommands({
        commandsToRun: ["device.info", "device.status"],
        requiredCommands: ["camera.snap", "device.info", "device.status"],
      }),
    ).toEqual(["camera.snap"]);
  });

  it("passes when all required commands are runnable", () => {
    expect(
      findMissingRequiredAndroidNodeCommands({
        commandsToRun: ["camera.snap", "device.info", "device.status"],
        requiredCommands: ["camera.snap", "device.info"],
      }),
    ).toEqual([]);
  });
});
