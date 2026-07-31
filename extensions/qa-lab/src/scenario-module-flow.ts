// QA Lab scenario module references normalize into the canonical flow shape.
import { z } from "zod";

const qaFlowModuleExportArgSchema = z
  .object({
    moduleExport: z.string().trim().min(1),
  })
  .strict();
const qaFlowModuleArgSchema = z.unknown().superRefine((arg, ctx) => {
  if (
    typeof arg !== "object" ||
    arg === null ||
    !("moduleExport" in arg) ||
    qaFlowModuleExportArgSchema.safeParse(arg).success
  ) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: "moduleExport arguments require a non-empty string export name",
  });
});
const qaFlowModuleSchema = z.object({
  module: z.string().trim().min(1),
  call: z.string().trim().min(1),
  args: z.array(qaFlowModuleArgSchema).optional(),
});
const qaFlowExecutionShape = {
  providerMode: z.enum(["aimock", "live-frontier", "mock-openai"]).optional(),
  retryCount: z.number().int().min(0).max(1).optional(),
  runtime: z.enum(["openclaw", "codex"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
};

type QaScenarioModuleFlow = z.infer<typeof qaFlowModuleSchema>;
type QaScenarioFlowShape = { steps: unknown[] };

function resolveRequiredChannelDriver(
  flow: QaScenarioFlowShape | QaScenarioModuleFlow | undefined,
): "live" | undefined {
  // Modules under live-transports consume adapter-prepared runtime context.
  // Crabline implements normalized transport only and cannot supply that context.
  return flow && "module" in flow && flow.module.startsWith("./live-transports/")
    ? "live"
    : undefined;
}

function normalizeQaScenarioFileMetadata<
  T extends { objective?: string; successCriteria?: string[] },
>(scenario: T, title: string) {
  return {
    ...scenario,
    title,
    objective: scenario.objective ?? title,
    successCriteria: scenario.successCriteria ?? [`${title} completes successfully.`],
  };
}

function resolveQaScenarioModuleArg(arg: unknown) {
  const parsed = qaFlowModuleExportArgSchema.safeParse(arg);
  if (!parsed.success) {
    return arg;
  }
  return {
    expr: `scenarioModule[${JSON.stringify(parsed.data.moduleExport)}]`,
  };
}

function resolveQaScenarioFileFlow<TFlow extends QaScenarioFlowShape>(
  flow: TFlow | QaScenarioModuleFlow | undefined,
  title: string,
) {
  if (!flow || "steps" in flow) {
    return flow;
  }
  return {
    steps: [
      {
        name: title,
        actions: [
          {
            set: "scenarioModule",
            value: { expr: `await qaImport(${JSON.stringify(flow.module)})` },
          },
          {
            call: `scenarioModule.${flow.call}`,
            ...(flow.args ? { args: flow.args.map(resolveQaScenarioModuleArg) } : {}),
            saveAs: "result",
          },
        ],
        detailsExpr:
          "result.details ?? (result.artifacts ? JSON.stringify(result.artifacts, null, 2) : undefined)",
      },
    ],
  };
}

function assertQaScenarioFlowDefined(params: {
  executionKind: string;
  flow: QaScenarioFlowShape | undefined;
  relativePath: string;
}) {
  if (params.executionKind === "flow" && !params.flow) {
    throw new Error(`${params.relativePath}: flow scenarios must define a top-level flow block`);
  }
}

export const qaScenarioModuleFlow = {
  assertDefined: assertQaScenarioFlowDefined,
  moduleSchema: qaFlowModuleSchema,
  executionShape: qaFlowExecutionShape,
  normalizeMetadata: normalizeQaScenarioFileMetadata,
  resolveRequiredChannelDriver,
  resolveFlow: resolveQaScenarioFileFlow,
};
