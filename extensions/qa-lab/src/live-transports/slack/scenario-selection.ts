import { listQaScenariosForExecutionProfile } from "../../scenario-catalog.js";

export function resolveSlackQaScenarioIds({ scenarioIds }: { scenarioIds?: readonly string[] }) {
  return scenarioIds?.length
    ? [...scenarioIds]
    : listQaScenariosForExecutionProfile("slack:default").map((scenario) => scenario.id);
}
