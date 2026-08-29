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
const qaSharedFlowSchema = z
  .object({
    shared: z.enum(["channel-access-control", "channel-restart-resume"]),
  })
  .strict();
const qaFlowProviderModeSchema = z.enum(["aimock", "live-frontier", "mock-openai"]);
const qaFlowExecutionShape = {
  providerMode: qaFlowProviderModeSchema.optional(),
  retryCount: z.number().int().min(0).max(1).optional(),
  runtime: z.enum(["openclaw", "codex"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
};

type QaScenarioModuleFlow = z.infer<typeof qaFlowModuleSchema>;
type QaScenarioSharedFlow = z.infer<typeof qaSharedFlowSchema>;
type QaScenarioFlowShape = { steps: unknown[] };

const qaSharedFlowPreparationActions = [
  { call: "waitForGatewayHealthy", args: [{ ref: "env" }, 60_000] },
  { call: "waitForTransportReady", args: [{ ref: "env" }, 60_000] },
  { resetTransport: true },
] as const;
// The DSL branch value is an action array, never a callable JavaScript `then`.
const qaSharedFlowPositiveBranch = ["th", "en"].join("");

const qaSharedFlows = {
  "channel-access-control": {
    steps: [
      {
        name: "enforces configured access policy",
        actions: [
          ...qaSharedFlowPreparationActions,
          {
            set: "marker",
            value: {
              expr: "`${config.markerPrefix}_${randomUUID().slice(0, 8).toUpperCase()}`",
            },
          },
          {
            set: "outboundCount",
            value: {
              expr: "getTransportSnapshot().messages.filter((message) => message.direction === 'outbound').length",
            },
          },
          {
            sendInbound: {
              conversation: {
                id: { ref: "config.conversationId" },
                kind: { ref: "config.conversationKind" },
              },
              senderId: { ref: "config.senderId" },
              senderName: "QA Driver",
              text: {
                expr: "`${config.mentionPrefix}Reply with only this exact marker: ${marker}`",
              },
            },
          },
          {
            // Object literals with a `then` property become JavaScript thenables.
            // Build the QA DSL branch as data so an accidental await cannot execute it.
            if: Object.fromEntries([
              ["expr", "config.expectReply"],
              [
                qaSharedFlowPositiveBranch,
                [
                  {
                    waitForOutbound: {
                      textIncludes: { ref: "marker" },
                      timeoutMs: { ref: "config.timeoutMs" },
                    },
                  },
                ],
              ],
              [
                "else",
                [
                  {
                    waitForNoOutbound: {
                      quietMs: { ref: "config.timeoutMs" },
                      sinceIndex: { ref: "outboundCount" },
                    },
                  },
                ],
              ],
            ]),
          },
        ],
        detailsExpr: "`${config.markerPrefix}: expectReply=${config.expectReply}`",
      },
    ],
  },
  "channel-restart-resume": {
    steps: [
      {
        name: "resumes after restart without replay",
        actions: [
          ...qaSharedFlowPreparationActions,
          {
            set: "firstMarker",
            value: {
              expr: "`${config.firstPrefix}_${randomUUID().slice(0, 8).toUpperCase()}`",
            },
          },
          {
            sendInbound: {
              conversation: {
                id: { ref: "config.conversationId" },
                kind: { ref: "config.conversationKind" },
              },
              senderId: { ref: "config.senderId" },
              senderName: "QA Driver",
              text: {
                expr: "`${config.mentionPrefix}Reply with only this exact marker: ${firstMarker}`",
              },
            },
          },
          {
            waitForOutbound: {
              textIncludes: { ref: "firstMarker" },
              timeoutMs: { ref: "config.timeoutMs" },
            },
          },
          {
            assert: {
              expr: "typeof env.gateway.restartAfterStateMutation === 'function'",
              message: "qa gateway child does not expose restartAfterStateMutation",
            },
          },
          {
            call: "env.gateway.restartAfterStateMutation",
            args: [
              {
                lambda: {
                  async: true,
                  params: ["ctx"],
                  expr: "Promise.resolve()",
                },
              },
            ],
          },
          { call: "waitForGatewayHealthy", args: [{ ref: "env" }, 60_000] },
          { call: "waitForTransportReady", args: [{ ref: "env" }, 60_000] },
          {
            set: "secondMarker",
            value: {
              expr: "`${config.secondPrefix}_${randomUUID().slice(0, 8).toUpperCase()}`",
            },
          },
          {
            sendInbound: {
              conversation: {
                id: { ref: "config.conversationId" },
                kind: { ref: "config.conversationKind" },
              },
              senderId: { ref: "config.senderId" },
              senderName: "QA Driver",
              text: {
                expr: "`${config.mentionPrefix}Reply with only this exact marker: ${secondMarker}`",
              },
            },
          },
          {
            waitForOutbound: {
              textIncludes: { ref: "secondMarker" },
              timeoutMs: { ref: "config.timeoutMs" },
            },
          },
        ],
        detailsExpr: "`${firstMarker} -> restart -> ${secondMarker}`",
      },
    ],
  },
} satisfies Record<QaScenarioSharedFlow["shared"], QaScenarioFlowShape>;

function resolveQaScenarioFlowKind(
  flow: QaScenarioFlowShape | QaScenarioModuleFlow | QaScenarioSharedFlow | undefined,
): "module" | "steps" | undefined {
  return flow ? ("module" in flow ? "module" : "steps") : undefined;
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
  flow: TFlow | QaScenarioModuleFlow | QaScenarioSharedFlow | undefined,
  title: string,
) {
  if (!flow || "steps" in flow) {
    return flow;
  }
  if ("shared" in flow) {
    return qaSharedFlows[flow.shared];
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
  providerModeSchema: qaFlowProviderModeSchema,
  resolveKind: resolveQaScenarioFlowKind,
  resolveFlow: resolveQaScenarioFileFlow,
  sharedSchema: qaSharedFlowSchema,
};
