import { listQaScenariosForExecutionProfile } from "../../scenario-catalog.js";

export function resolveWhatsAppQaScenarioIds(params: {
  providerMode: string;
  scenarioIds?: readonly string[];
}) {
  if (params.scenarioIds?.length) {
    return [...params.scenarioIds];
  }
  const profile = params.providerMode === "mock-openai" ? "mock-default" : "default";
  return listQaScenariosForExecutionProfile(`whatsapp:${profile}`).map((scenario) => scenario.id);
}
