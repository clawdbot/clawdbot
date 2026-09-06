import path from "node:path";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import type { NativeControlUiPluginFixture } from "./control-ui-plugin-fixture.ts";

const workboardNativePlugins: NativeControlUiPluginFixture[] = [
  {
    pluginId: "workboard",
    rootDir: path.resolve(import.meta.dirname, "../../../extensions/workboard"),
    source: "browser/index.ts",
  },
];

export const workboardUi = {
  nativePlugins: workboardNativePlugins,
  controlUiTabs: [
    {
      pluginId: "workboard",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
    },
  ],
} satisfies Pick<ControlUiMockGatewayScenario, "nativePlugins" | "controlUiTabs">;
