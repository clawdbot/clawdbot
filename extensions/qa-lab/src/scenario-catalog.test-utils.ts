import fs from "node:fs";
import { expect } from "vitest";
import { readQaScenarioPack } from "./scenario-catalog.js";

type CatalogScenario = ReturnType<typeof readQaScenarioPack>["scenarios"][number];
type FlowCatalogScenario = CatalogScenario & {
  execution: Extract<CatalogScenario["execution"], { kind: "flow" }>;
};

export function listScenarioMarkdownPaths(dir = "qa/scenarios"): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return listScenarioMarkdownPaths(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    })
    .toSorted();
}

export function isFlowScenario(scenario: CatalogScenario): scenario is FlowCatalogScenario {
  return scenario.execution.kind === "flow";
}

export function requireFlowScenario(scenario: CatalogScenario): FlowCatalogScenario {
  expect(scenario.execution.kind).toBe("flow");
  if (!isFlowScenario(scenario)) {
    throw new Error(`expected ${scenario.id} to be a flow scenario`);
  }
  return scenario;
}

export function flowContainsCall(value: unknown, callName: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => flowContainsCall(entry, callName));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.call === callName ||
    Object.values(record).some((entry) => flowContainsCall(entry, callName))
  );
}
