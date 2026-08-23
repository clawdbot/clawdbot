import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("./src/store.js", () => ({
  WorkboardStore: { openSqlite: () => ({}) },
}));

import plugin from "./index.js";

describe("Workboard plugin registration", () => {
  it("advertises its native route only while the plugin runtime is active", () => {
    const captured = capturePluginRegistration({
      id: "workboard",
      name: "Workboard",
      register: plugin.register,
    });

    expect(captured.controlUiDescriptors).toContainEqual({
      surface: "tab",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  });
});
