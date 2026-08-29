import crypto from "node:crypto";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import type { ComputerActResult } from "../../plugins/computer-use-contract.js";
import { DEFAULT_IMAGE_MAX_DIMENSION_PX } from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import type {
  ComputerContextEpoch,
  ComputerTarget,
  ComputerToolAction,
  ScreenshotCapture,
} from "./computer-tool-shared.js";
import { COMPUTER_REF_WIDTH, MODEL_OBSERVATION_MAX_ELEMENTS } from "./computer-tool-shared.js";

type ModelObservationProjection = NonNullable<ComputerActResult["observation"]> & {
  truncatedElements?: number;
};

function projectComputerActResultMetadata(result: ComputerActResult) {
  let observation: ModelObservationProjection | undefined = result.observation
    ? { ...result.observation, ...(result.observation.base64 ? { base64: "[image]" } : {}) }
    : undefined;
  if (observation?.elements && observation.elements.length > MODEL_OBSERVATION_MAX_ELEMENTS) {
    observation = {
      ...observation,
      elements: observation.elements.slice(0, MODEL_OBSERVATION_MAX_ELEMENTS),
      truncatedElements: observation.elements.length - MODEL_OBSERVATION_MAX_ELEMENTS,
    };
  }
  const details = result.details ? { ...result.details } : undefined;
  if (
    details &&
    Array.isArray(details.elements) &&
    details.elements.length > MODEL_OBSERVATION_MAX_ELEMENTS
  ) {
    const originalLength = details.elements.length;
    details.elements = details.elements.slice(0, MODEL_OBSERVATION_MAX_ELEMENTS);
    details.truncatedElements = originalLength - MODEL_OBSERVATION_MAX_ELEMENTS;
  }
  return {
    ...result,
    ...(observation ? { observation } : {}),
    ...(details ? { details } : {}),
  };
}

export function computerActResultText(
  action: ComputerToolAction,
  result: ComputerActResult,
): string {
  return JSON.stringify({ action, ...projectComputerActResultMetadata(result) });
}

function computerFrameImageIdentity(
  content: AgentToolResult<unknown>["content"],
): string | undefined {
  const images = content.filter(
    (block): block is Extract<(typeof content)[number], { type: "image" }> =>
      block.type === "image",
  );
  if (images.length !== 1) {
    return undefined;
  }
  const image = images.at(0);
  if (!image) {
    return undefined;
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([image.mimeType, image.data]))
    .digest("hex");
}

function invalidateComputerFrame(contextEpoch: ComputerContextEpoch): boolean {
  if (contextEpoch.frameToolCallId === undefined && contextEpoch.frameImageIdentity === undefined) {
    return false;
  }
  contextEpoch.value += 1;
  delete contextEpoch.frameToolCallId;
  delete contextEpoch.frameImageIdentity;
  return true;
}

/**
 * Invalidate screenshot coordinates when the final model context no longer
 * contains the image produced by the tracked computer tool result.
 */
export function invalidateComputerFrameIfMissing(params: {
  contextEpoch: ComputerContextEpoch;
  messages: AgentMessage[];
  imagesBlocked?: boolean;
}): boolean {
  const frameToolCallId = params.contextEpoch.frameToolCallId;
  if (frameToolCallId === undefined) {
    return invalidateComputerFrame(params.contextEpoch);
  }

  let frameImageIdentity: string | undefined;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (
      message?.role !== "toolResult" ||
      message.toolName !== "computer" ||
      message.toolCallId !== frameToolCallId
    ) {
      continue;
    }
    frameImageIdentity = computerFrameImageIdentity(message.content);
    break;
  }

  if (
    !params.imagesBlocked &&
    frameImageIdentity !== undefined &&
    frameImageIdentity === params.contextEpoch.frameImageIdentity
  ) {
    return false;
  }
  return invalidateComputerFrame(params.contextEpoch);
}

/**
 * The reference frame width both the screenshot and the coordinates use.
 * Capped at the model's image sanitization limit so a persisted screenshot that
 * is replay-sanitized in a later turn is not resized underneath the coordinate
 * frame the model is still issuing `refWidth` against.
 */
export function resolveReferenceWidth(limits: { maxDimensionPx?: number }): number {
  const sanitizationLimit = limits.maxDimensionPx ?? DEFAULT_IMAGE_MAX_DIMENSION_PX;
  return Math.max(1, Math.min(COMPUTER_REF_WIDTH, sanitizationLimit));
}

export async function projectScreenshotResult(params: {
  capture: ScreenshotCapture;
  noteLines: string[];
  target: ComputerTarget;
  action: ComputerToolAction;
  referenceWidth: number;
  modelHasVision?: boolean;
}): Promise<{
  result: AgentToolResult<unknown>;
  frameId: string;
  imageIdentity?: string;
}> {
  const { capture, target } = params;
  const frameId = crypto.randomUUID();
  // Report the delivered dimensions, not the pre-sanitization capture size:
  // sanitizeToolResultImages caps the longest edge to referenceWidth, so a
  // portrait capture is scaled down. Advertising the original size would let
  // the model pick coordinates against a wider frame than it was shown.
  const longestEdge = Math.max(capture.width ?? 0, capture.height ?? 0);
  const frameScale = longestEdge > params.referenceWidth ? params.referenceWidth / longestEdge : 1;
  const deliveredWidth = capture.width != null ? Math.round(capture.width * frameScale) : undefined;
  const deliveredHeight =
    capture.height != null ? Math.round(capture.height * frameScale) : undefined;
  const dims =
    deliveredWidth && deliveredHeight ? `${deliveredWidth}x${deliveredHeight}` : "unknown size";
  const text = [
    ...params.noteLines,
    `screenshot ${dims} (screen ${target.screenIndex}, frameId ${frameId})`,
  ].join("\n");
  const content: AgentToolResult<unknown>["content"] = [{ type: "text", text }];
  if (params.modelHasVision !== false) {
    content.push({ type: "image", data: capture.base64, mimeType: capture.mimeType });
  } else {
    content.push({
      type: "text",
      text: "[model has no vision; screenshot omitted — use a vision-capable model for computer use]",
    });
  }
  // Cap the delivered screenshot's longest edge to the reference width so
  // the coordinate frame is stable across turns. Replay-sanitization in
  // later turns caps the longest edge to the configured limit, which is
  // >= referenceWidth, so it is a no-op and the node maps coordinates
  // against this same width for both portrait and landscape captures. A
  // portrait frame (height > referenceWidth) is uniformly scaled down here,
  // matching OpenClawComputerInputGeometry.capturedWidth on the node.
  // media.outbound=false keeps desktop pixels model-only (#44759).
  const result = await sanitizeToolResultImages(
    {
      content,
      details: {
        node: target.nodeId,
        action: params.action,
        width: deliveredWidth,
        height: deliveredHeight,
        screenIndex: target.screenIndex,
        frameId,
        refWidth: params.referenceWidth,
        media: { outbound: false },
      },
    },
    `computer:${params.action}`,
    { maxDimensionPx: params.referenceWidth },
  );
  return {
    result,
    frameId,
    imageIdentity: computerFrameImageIdentity(result.content),
  };
}

export async function projectComputerActResult(params: {
  result: ComputerActResult;
  target: ComputerTarget;
  action: ComputerToolAction;
  referenceWidth: number;
  modelHasVision?: boolean;
}): Promise<AgentToolResult<unknown>> {
  const observation = params.result.observation;
  // Pixels belong only in image content; diagnostic copies exceed transcript
  // control budgets and can expose images even when model vision is disabled.
  const result = projectComputerActResultMetadata(params.result);
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: JSON.stringify({ action: params.action, ...result }) },
  ];
  // Observation images have no context-presence tracking, so they must never be deduplicated.
  if (observation?.base64 && params.modelHasVision !== false) {
    content.push({
      type: "image",
      data: observation.base64,
      mimeType: imageMimeFromFormat(observation.format ?? "png") ?? "image/png",
    });
  }
  return await sanitizeToolResultImages(
    {
      content,
      details: {
        node: params.target.nodeId,
        action: params.action,
        screenIndex: params.target.screenIndex,
        result,
        media: { outbound: false },
      },
    },
    `computer:${params.action}`,
    { maxDimensionPx: params.referenceWidth },
  );
}
