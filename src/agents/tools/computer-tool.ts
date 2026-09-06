import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ComputerUseV2ActionName } from "../../plugins/computer-use-contract.js";
import { sleep } from "../../utils/sleep.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { type AnyAgentTool, readFiniteNumberParam, readToolStringParam } from "./common.js";
import { buildComputerToolDescription } from "./computer-tool-guidance.js";
import { ComputerToolSession } from "./computer-tool-node.js";
import { buildComputerActParams, isComputerActAction } from "./computer-tool-request.js";
import {
  computerActResultText,
  projectComputerActResult,
  projectScreenshotResult,
  resolveReferenceWidth,
} from "./computer-tool-result.js";
import {
  availableComputerActions,
  COMPUTER_TOOL_ACTIONS,
  createComputerToolSchema,
} from "./computer-tool-schema.js";
import type {
  ComputerContextEpoch,
  ComputerToolAction,
  ComputerToolTransport,
  ResolvedComputerTarget,
} from "./computer-tool-shared.js";
import {
  AFTER_ACTION_SCREENSHOT_DELAY_MS,
  isComputerObservationAction,
  MAX_WAIT_SECONDS,
} from "./computer-tool-shared.js";
import { readGatewayCallOptions } from "./gateway.js";

export type { ComputerContextEpoch, ComputerToolTransport } from "./computer-tool-shared.js";
export { invalidateComputerFrameIfMissing } from "./computer-tool-result.js";

export function createComputerTool(options?: {
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  /** Stable run scope used to deduplicate a replayed model tool call on the node. */
  idempotencyScope?: string;
  /** Tracks whether the current screenshot pixels still reach model context. */
  contextEpoch?: ComputerContextEpoch;
  /** Host-owned session desktop; omitted for ordinary paired-node selection. */
  transport?: ComputerToolTransport;
  /** Attempt owner for deterministic provider-execution cleanup. */
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
}): AnyAgentTool {
  const executionId = crypto.randomUUID();
  const hasCleanupOwner = options?.registerRunCleanup !== undefined;
  const availableActions = (actions: readonly ComputerUseV2ActionName[]) =>
    availableComputerActions(actions, hasCleanupOwner);
  const configuredLimits = resolveImageSanitizationLimits(options?.config);
  const referenceWidth = resolveReferenceWidth(configuredLimits);
  const targetScope = options?.transport ? "session" : "paired";
  // Harnesses serialize the schema before execution; a prepared desktop must
  // advertise its full action surface before the first observation.
  const initialCapabilities = options?.transport?.computerUse;
  const parameterSchema = createComputerToolSchema(
    availableActions(initialCapabilities?.actions ?? COMPUTER_TOOL_ACTIONS),
    targetScope,
  );
  const replaceParameterSchema = (actions: readonly ComputerUseV2ActionName[]) => {
    const next = createComputerToolSchema(actions, targetScope);
    for (const key of Object.keys(parameterSchema)) {
      Reflect.deleteProperty(parameterSchema, key);
    }
    Object.assign(parameterSchema, next);
  };

  // Serialize execute() per tool instance. This runtime can dispatch parallel
  // tool calls (some providers enable it by default), but desktop input and the
  // shared target/frame/button state must apply in model order, not completion
  // order: a click racing a type could type into the wrong app, and split
  // mouse down/move/up could interleave. Chaining preserves invocation order.
  let opQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = opQueue.then(fn, fn);
    opQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const session = new ComputerToolSession({
    executionId,
    idempotencyScope: options?.idempotencyScope,
    contextEpoch: options?.contextEpoch,
    transport: options?.transport,
    availableActions,
    defaultActions: COMPUTER_TOOL_ACTIONS,
    onCapabilitiesChanged: (capabilities) => {
      replaceParameterSchema(availableActions(capabilities?.actions ?? COMPUTER_TOOL_ACTIONS));
      tool.description = buildComputerToolDescription(capabilities, targetScope);
    },
    registerRunCleanup: options?.registerRunCleanup,
    getOperationQueue: () => opQueue,
  });

  const captureAndDeliverScreenshot = async (params: {
    noteLines: string[];
    resolved: ResolvedComputerTarget;
    action: ComputerToolAction;
    toolCallId: string;
    signal?: AbortSignal;
  }) => {
    const capture = await session.captureScreenshot(params.resolved, referenceWidth, params.signal);
    const projected = await projectScreenshotResult({
      capture,
      noteLines: params.noteLines,
      target: params.resolved.target,
      action: params.action,
      referenceWidth,
      modelHasVision: options?.modelHasVision,
    });
    const previousFrame = session.refreshUnchangedFrame({
      target: params.resolved.target,
      capture,
      imageIdentity: projected.imageIdentity,
      modelHasVision: options?.modelHasVision,
    });
    if (previousFrame) {
      const text = [
        ...params.noteLines,
        `screen unchanged since previous frame (frameId ${previousFrame.id}); screenshot omitted — keep using this frameId for coordinates`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          node: params.resolved.target.nodeId,
          action: params.action,
          screenIndex: params.resolved.target.screenIndex,
          frameId: previousFrame.id,
          refWidth: referenceWidth,
        },
      };
    }
    session.bindDeliveredFrame({
      resolved: params.resolved,
      capture,
      frameId: projected.frameId,
      toolCallId: params.toolCallId,
      imageIdentity: projected.imageIdentity,
      modelHasVision: options?.modelHasVision,
    });
    return projected.result;
  };

  const tool: AnyAgentTool = {
    label: "Computer",
    name: "computer",
    // Catalog bridges serialize nested results as JSON, which strips the
    // model-visible screenshot block that coordinate actions depend on.
    catalogMode: "direct-only",
    executionMode: "sequential",
    description: buildComputerToolDescription(initialCapabilities, targetScope),
    parameters: parameterSchema,
    execute: (toolCallId, args, signal) =>
      serialize(async () => {
        signal?.throwIfAborted();
        const params = args as Record<string, unknown>;
        const action = readToolStringParam(params, "action", {
          required: true,
        }) as ComputerToolAction;
        const gatewayOpts = readGatewayCallOptions(params);
        const resolved = await session.resolveTarget({
          action,
          input: params,
          gatewayOpts,
          signal,
        });

        if (action === "screenshot" || action === "wait") {
          const noteLines: string[] = [];
          if (action === "wait") {
            const seconds =
              readFiniteNumberParam(params, "duration", {
                min: 0,
                max: MAX_WAIT_SECONDS,
                message: `duration must be 0-${MAX_WAIT_SECONDS} seconds for wait`,
              }) ?? 1;
            await sleep(Math.round(seconds * 1000), signal);
            noteLines.push(`waited ${seconds}s`);
          }
          return await captureAndDeliverScreenshot({
            noteLines,
            resolved,
            action,
            toolCallId,
            signal,
          });
        }

        if (!isComputerActAction(action)) {
          throw new Error(`Unknown action: ${action}`);
        }
        const wireParams = buildComputerActParams({
          action,
          input: params,
          executionId,
          screenIndex: resolved.target.screenIndex,
          displayFrameId: resolved.frame?.displayFrameId,
          refWidth: referenceWidth,
        });
        const actResult = await session.invokeComputerAct({
          resolved,
          wireParams,
          toolCallId,
          signal,
        });
        if (actResult.observation || isComputerObservationAction(action, params.dialogAction)) {
          session.setTarget(resolved.target);
          const projected = await projectComputerActResult({
            result: actResult,
            target: resolved.target,
            action,
            referenceWidth,
            modelHasVision: options?.modelHasVision,
          });
          session.recordObservation(resolved, actResult, projected.imageCoordinates);
          return projected.result;
        }
        try {
          await sleep(AFTER_ACTION_SCREENSHOT_DELAY_MS, signal);
          return await captureAndDeliverScreenshot({
            noteLines: [computerActResultText(action, actResult)],
            resolved,
            action,
            toolCallId,
            signal,
          });
        } catch (err) {
          session.setTarget(resolved.target);
          signal?.throwIfAborted();
          // Input landed; a failed follow-up screenshot should not fail the action.
          return {
            content: [
              {
                type: "text",
                text: `${computerActResultText(action, actResult)}\nfollow-up screenshot failed: ${formatErrorMessage(err)}`,
              },
            ],
            details: {
              node: resolved.target.nodeId,
              action,
              screenIndex: resolved.target.screenIndex,
              result: actResult,
            },
          };
        }
      }),
  };
  return tool;
}
