// QA Lab plugin module owns canonical profile scheduling evidence.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";

const idSchema = z.string().trim().min(1);
const cellSchema = z.strictObject({
  scenarioId: idSchema,
  executionKind: z.enum(["flow", "script", "vitest", "playwright"]),
  channel: idSchema.nullable(),
});
const listNames = [
  "membership",
  "selected",
  "excluded",
  "expectedCells",
  "observedCells",
  "missingCells",
] as const;
type ListName = (typeof listNames)[number];
const planShape = z.strictObject({
  profile: idSchema,
  membership: z.array(idSchema),
  selected: z.array(idSchema),
  excluded: z.array(
    z.strictObject({
      scenarioId: idSchema,
      reasons: z.array(idSchema).min(1),
    }),
  ),
  expectedCells: z.array(cellSchema),
  observedCells: z.array(cellSchema),
  missingCells: z.array(cellSchema),
  counts: z.record(z.enum(listNames), z.number().int().nonnegative()),
});

type PlanShape = z.infer<typeof planShape>;

function cellKey(cell: z.infer<typeof cellSchema>) {
  return `${cell.scenarioId}\u0000${cell.executionKind}\u0000${cell.channel ?? ""}`;
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonical(name: string, values: readonly string[]) {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    throw new Error(`${name} must be unique and sorted`);
  }
}

function assertSame(message: string, left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(message);
  }
}

function planLists(plan: PlanShape): Record<ListName, string[]> {
  return {
    membership: plan.membership,
    selected: plan.selected,
    excluded: plan.excluded.map((entry) => entry.scenarioId),
    expectedCells: plan.expectedCells.map(cellKey),
    observedCells: plan.observedCells.map(cellKey),
    missingCells: plan.missingCells.map(cellKey),
  };
}

function assertPlanInvariants(plan: PlanShape) {
  const lists = planLists(plan);
  for (const name of listNames) {
    assertCanonical(name, lists[name]);
    if (plan.counts[name] !== lists[name].length) {
      throw new Error(`counts.${name} must equal ${lists[name].length}`);
    }
  }
  for (const exclusion of plan.excluded) {
    assertCanonical(`exclusion reasons for ${exclusion.scenarioId}`, exclusion.reasons);
  }
  assertSame(
    "selected and excluded scenarios must exactly partition membership",
    lists.membership,
    [...lists.selected, ...lists.excluded].toSorted(),
  );
  assertSame(
    "expected cells must exactly cover selected scenarios",
    lists.selected,
    [...new Set(plan.expectedCells.map((cell) => cell.scenarioId))].toSorted(),
  );
  const expected = new Set(lists.expectedCells);
  const observed = new Set(lists.observedCells);
  if (lists.observedCells.some((cell) => !expected.has(cell))) {
    throw new Error("unexpected execution cells invalidate evidence");
  }
  assertSame(
    "missing cells must equal expected minus observed",
    lists.missingCells,
    lists.expectedCells.filter((cell) => !observed.has(cell)),
  );
}

const schema = planShape.superRefine((plan, context) => {
  try {
    assertPlanInvariants(plan);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export type QaProfileEvidencePlan = z.infer<typeof schema>;

function canonicalCells(cells: readonly QaScenarioExecutionCell[]) {
  return cells
    .map((cell) => ({ ...cell, channel: cell.channel ?? null }))
    .toSorted((left, right) => compareStrings(cellKey(left), cellKey(right)));
}

function build(params: {
  profile: string;
  membershipScenarios: readonly QaSeedScenarioWithSource[];
  selectedScenarios: readonly QaSeedScenarioWithSource[];
  excludedScenarios: readonly {
    scenario: QaSeedScenarioWithSource;
    reasons: readonly string[];
  }[];
  expectedCells: readonly QaScenarioExecutionCell[];
  observedCells: readonly QaScenarioExecutionCell[];
}) {
  const membership = params.membershipScenarios.map((scenario) => scenario.id).toSorted();
  const selected = params.selectedScenarios.map((scenario) => scenario.id).toSorted();
  const excluded = params.excludedScenarios
    .map(({ scenario, reasons }) => ({
      scenarioId: scenario.id,
      reasons: [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))].toSorted(),
    }))
    .toSorted((left, right) => compareStrings(left.scenarioId, right.scenarioId));
  const expectedCells = canonicalCells(params.expectedCells);
  const observedCells = canonicalCells(params.observedCells);
  const observedKeys = new Set(observedCells.map(cellKey));
  const missingCells = expectedCells.filter((cell) => !observedKeys.has(cellKey(cell)));
  const lists = { membership, selected, excluded, expectedCells, observedCells, missingCells };
  return schema.parse({
    profile: params.profile,
    ...lists,
    counts: Object.fromEntries(listNames.map((name) => [name, lists[name].length])),
  });
}

function attest(value: unknown, successful = false) {
  const plan = schema.parse(value);
  if (successful && plan.missingCells.length > 0) {
    throw new Error(
      `successful QA profile evidence is missing ${plan.missingCells.length} expected execution cell(s)`,
    );
  }
  return {
    plan,
    sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
}

export const qaProfileEvidencePlan = {
  attest,
  build,
  schema,
};
