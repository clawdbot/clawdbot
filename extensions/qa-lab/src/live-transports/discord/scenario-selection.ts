import { listQaScenariosForExecutionProfile } from "../../scenario-catalog.js";

export function resolveDiscordQaScenarioIds({ scenarioIds }: { scenarioIds?: readonly string[] }) {
  return scenarioIds?.length
    ? [...scenarioIds]
    : listQaScenariosForExecutionProfile("discord:adapter").map((scenario) => scenario.id);
}
