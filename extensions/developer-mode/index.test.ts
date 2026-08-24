import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("Developer Mode plugin registration", () => {
  it("registers the three OpenClaw Tool mode presets", () => {
    const captured = capturePluginRegistration({
      id: "developer-mode",
      name: "Developer Mode",
      register: plugin.register,
    });

    expect(captured.sessionToolModes).toEqual([
      expect.objectContaining({ id: "standard", default: true, codeMode: "direct" }),
      expect.objectContaining({ id: "code", toolProfile: "coding", codeMode: "code" }),
      expect.objectContaining({ id: "minimal", toolProfile: "minimal", codeMode: "direct" }),
    ]);
  });
});
