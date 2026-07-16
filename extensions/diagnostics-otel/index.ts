import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDiagnosticsOtelService } from "./src/service.js";

export default definePluginEntry({
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  register(api) {
    api.registerService(createDiagnosticsOtelService());
  },
});
