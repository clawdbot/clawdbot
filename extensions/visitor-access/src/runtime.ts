import { createPluginRuntimeStore } from "../api.js";
import type { VisitorAccessService } from "./visitors.js";

export type VisitorRuntime = {
  service: VisitorAccessService;
  errorText: (error: unknown) => string;
};

// Discovery registries can load separate module instances. Only the Gateway
// service publishes this slot, so all tools share its queue and lifetime.
export const visitorRuntimeStore = createPluginRuntimeStore<VisitorRuntime>({
  key: "plugin-runtime:visitor-access:active",
  errorMessage: "Start the Gateway with visitor-access enabled before managing visitors.",
});
