import "./auth-plan.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type EmbeddedRunAuthPlanTestApi = {
  loadEmbeddedRunAuthProfileStore(params: {
    agentDir: string;
    config: RunEmbeddedAgentParams["config"];
    externalCliProviderIds: Iterable<string>;
  }): AuthProfileStore;
};

function getTestApi(): EmbeddedRunAuthPlanTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedRunAuthPlanTestApi")
  ] as EmbeddedRunAuthPlanTestApi;
}

export const testing: EmbeddedRunAuthPlanTestApi = {
  loadEmbeddedRunAuthProfileStore: (params) => getTestApi().loadEmbeddedRunAuthProfileStore(params),
};
