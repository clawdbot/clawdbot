import { createPluginBoardWidgetContentKindRegistrar } from "../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";

export function registerTestWidgetContentKind(
  kind = "diagram",
  composeDocument = ({ source }: { source: string }) => `<main>${source}</main>`,
): void {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "diagram",
    source: "diagram-fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  createPluginBoardWidgetContentKindRegistrar(registry)(record, {
    kind,
    label: "Diagram",
    resources: { surface: "diagram", paths: ["/__openclaw__/diagram/app.js"] },
    validateSource(source) {
      if (!source.startsWith("diagram:")) {
        throw new Error("diagram prefix required");
      }
    },
    composeDocument,
  });
  setActivePluginRegistry(registry);
}
