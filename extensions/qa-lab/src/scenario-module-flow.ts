// QA Lab scenario module references normalize into the canonical flow shape.
import { z } from "zod";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

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
const qaFlowProviderModeSchema = z.enum(["aimock", "live-frontier", "mock-openai"]);
const qaFlowExecutionShape = {
  providerMode: qaFlowProviderModeSchema.optional(),
  retryCount: z.number().int().min(0).max(1).optional(),
  runtime: z.enum(["openclaw", "codex"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
};

type QaScenarioModuleFlow = z.infer<typeof qaFlowModuleSchema>;
type QaScenarioFlowShape = { steps: unknown[] };

type QaSharedChannelFlowParams = {
  config: Record<string, unknown>;
  env: {
    gateway: Pick<QaSuiteRuntimeEnv["gateway"], "restartAfterStateMutation">;
  };
  randomUUID: () => string;
  transport: Pick<
    QaTransportAdapter,
    "reset" | "sendInbound" | "waitForNoOutbound" | "waitForOutbound"
  >;
  waitForGatewayHealthy: (env: unknown, timeoutMs: number) => Promise<unknown>;
  waitForTransportReady: (env: unknown, timeoutMs: number) => Promise<unknown>;
};

type QaSharedChannelMessageConfig = {
  conversationId: string;
  conversationKind: "direct" | "group";
  mentionPrefix: string;
  senderId: string;
};

const qaAccessControlFlowConfigSchema = z.object({
  conversationId: z.string(),
  conversationKind: z.enum(["direct", "group"]),
  expectReply: z.boolean(),
  markerPrefix: z.string(),
  mentionPrefix: z.string(),
  senderId: z.string(),
  timeoutMs: z.number().int().positive(),
});

const qaRestartResumeFlowConfigSchema = z.object({
  conversationId: z.string(),
  conversationKind: z.enum(["direct", "group"]),
  firstPrefix: z.string(),
  mentionPrefix: z.string(),
  secondPrefix: z.string(),
  senderId: z.string(),
  timeoutMs: z.number().int().positive(),
});

async function prepareQaSharedChannelFlow(params: QaSharedChannelFlowParams) {
  await params.waitForGatewayHealthy(params.env, 60_000);
  await params.waitForTransportReady(params.env, 60_000);
  await params.transport.reset();
}

function buildQaSharedChannelMarker(prefix: string, randomUUID: () => string) {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function sendQaSharedChannelMarker(
  params: QaSharedChannelFlowParams,
  config: QaSharedChannelMessageConfig,
  marker: string,
) {
  await params.transport.sendInbound({
    conversation: {
      id: config.conversationId,
      kind: config.conversationKind,
    },
    senderId: config.senderId,
    senderName: "QA Driver",
    text: `${config.mentionPrefix}Reply with only this exact marker: ${marker}`,
  });
}

export async function runQaAccessControlScenarioFlow(
  params: QaSharedChannelFlowParams & {
    getTransportSnapshot: QaTransportAdapter["state"]["getSnapshot"];
  },
) {
  const config = qaAccessControlFlowConfigSchema.parse(params.config);
  await prepareQaSharedChannelFlow(params);
  const marker = buildQaSharedChannelMarker(config.markerPrefix, params.randomUUID);
  const outboundCount = params
    .getTransportSnapshot()
    .messages.filter((message) => message.direction === "outbound").length;
  await sendQaSharedChannelMarker(params, config, marker);
  if (config.expectReply) {
    await params.transport.waitForOutbound({ textIncludes: marker, timeoutMs: config.timeoutMs });
  } else {
    await params.transport.waitForNoOutbound({
      quietMs: config.timeoutMs,
      sinceIndex: outboundCount,
    });
  }
  return { details: `${config.markerPrefix}: expectReply=${config.expectReply}` };
}

export async function runQaRestartResumeScenarioFlow(params: QaSharedChannelFlowParams) {
  const config = qaRestartResumeFlowConfigSchema.parse(params.config);
  await prepareQaSharedChannelFlow(params);
  const firstMarker = buildQaSharedChannelMarker(config.firstPrefix, params.randomUUID);
  await sendQaSharedChannelMarker(params, config, firstMarker);
  await params.transport.waitForOutbound({
    textIncludes: firstMarker,
    timeoutMs: config.timeoutMs,
  });

  const restart = params.env.gateway.restartAfterStateMutation;
  if (!restart) {
    throw new Error("qa gateway child does not expose restartAfterStateMutation");
  }
  await restart(async () => undefined);
  await params.waitForGatewayHealthy(params.env, 60_000);
  await params.waitForTransportReady(params.env, 60_000);

  const secondMarker = buildQaSharedChannelMarker(config.secondPrefix, params.randomUUID);
  await sendQaSharedChannelMarker(params, config, secondMarker);
  await params.transport.waitForOutbound({
    textIncludes: secondMarker,
    timeoutMs: config.timeoutMs,
  });
  return { details: `${firstMarker} -> restart -> ${secondMarker}` };
}

function resolveQaScenarioFlowKind(
  flow: QaScenarioFlowShape | QaScenarioModuleFlow | undefined,
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
  providerModeSchema: qaFlowProviderModeSchema,
  resolveKind: resolveQaScenarioFlowKind,
  resolveFlow: resolveQaScenarioFileFlow,
};
