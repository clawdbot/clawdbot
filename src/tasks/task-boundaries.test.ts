import { beforeAll, describe, expect, it } from "vitest";
import {
  listTaskBoundarySourceFiles,
  readTaskBoundarySource,
  toTaskBoundaryRelativePath,
} from "./import-boundary.test-helpers.js";

type TaskBoundarySource = {
  relative: string;
  source: string;
};

const RAW_TASK_MUTATORS = [
  "createTaskRecord",
  "markTaskRunningByRunId",
  "markTaskTerminalByRunId",
  "markTaskTerminalById",
  "setTaskRunDeliveryStatusByRunId",
] as const;

const RAW_TASK_MUTATOR_ALLOWED_CALLERS = new Set([
  "tasks/task-executor.ts",
  "tasks/task-registry.ts",
  "tasks/task-registry.maintenance.ts",
]);

const TASK_FLOW_REGISTRY_ALLOWED_IMPORTERS = new Set([
  "tasks/task-flow-owner-access.ts",
  "tasks/task-flow-registry.audit.ts",
  "tasks/task-flow-registry.maintenance.ts",
  "tasks/task-flow-runtime-internal.ts",
]);

const TASK_REGISTRY_ALLOWED_IMPORTERS = new Set([
  "tasks/runtime-internal.ts",
  "tasks/task-owner-access.ts",
  "tasks/task-status-access.ts",
]);

let sources: TaskBoundarySource[] = [];

beforeAll(async () => {
  sources = await Promise.all(
    (await listTaskBoundarySourceFiles()).map(async (file) => ({
      relative: toTaskBoundaryRelativePath(file),
      source: await readTaskBoundarySource(file),
    })),
  );
});

describe("task boundaries", () => {
  it("keeps raw task lifecycle mutators behind task internals", () => {
    const offenders: string[] = [];
    for (const { relative, source } of sources) {
      if (RAW_TASK_MUTATOR_ALLOWED_CALLERS.has(relative)) {
        continue;
      }
      for (const symbol of RAW_TASK_MUTATORS) {
        if (source.includes(`${symbol}(`)) {
          offenders.push(`${relative}:${symbol}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps direct task-flow-registry imports behind approved task-flow access seams", () => {
    const importers = sources
      .filter(({ source }) => source.includes("task-flow-registry.js"))
      .map(({ relative }) => relative);

    expect(importers.toSorted()).toEqual([...TASK_FLOW_REGISTRY_ALLOWED_IMPORTERS].toSorted());
  });

  it("keeps direct task-registry imports behind the approved task access seams", () => {
    const importers = sources
      .filter(({ source }) => source.includes("task-registry.js"))
      .map(({ relative }) => relative);

    expect(importers.toSorted()).toEqual([...TASK_REGISTRY_ALLOWED_IMPORTERS].toSorted());
  });
});
