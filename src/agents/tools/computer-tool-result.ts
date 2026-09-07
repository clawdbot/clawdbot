import crypto from "node:crypto";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import { readImageMetadataFromHeader } from "../../media/image-ops.js";
import type { ComputerActResult } from "../../plugins/computer-use-contract.js";
import { DEFAULT_IMAGE_MAX_DIMENSION_PX } from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import type {
  ComputerContextEpoch,
  ComputerObservationState,
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
  const [image, duplicate] = content.filter((block) => block.type === "image");
  if (!image || duplicate) {
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
  if (frameToolCallId === undefined || params.imagesBlocked) {
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

async function projectComputerImage(params: {
  image?: { base64: string; mimeType: string };
  action: ComputerToolAction;
  referenceWidth: number;
  modelHasVision?: boolean;
}) {
  // Keep the delivered pixels within the replay cap so later turns cannot
  // resize the image underneath the coordinates bound to it.
  const content = await sanitizeContentBlocksImages(
    params.image && params.modelHasVision !== false
      ? [{ type: "image", data: params.image.base64, mimeType: params.image.mimeType }]
      : [],
    `computer:${params.action}`,
    { maxDimensionPx: params.referenceWidth },
  );
  const image = content.find((block) => block.type === "image");
  const dimensions = image ? readImageMetadataFromHeader(Buffer.from(image.data, "base64")) : null;
  return { content, image, dimensions };
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
  const { content, dimensions } = await projectComputerImage({ ...params, image: capture });
  const dims = dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown size";
  const text = [
    ...params.noteLines,
    `screenshot ${dims} (screen ${target.screenIndex}, frameId ${frameId})`,
  ].join("\n");
  if (params.modelHasVision === false) {
    content.push({
      type: "text",
      text: "[model has no vision; screenshot omitted — use a vision-capable model for computer use]",
    });
  }
  const result = {
    content: [{ type: "text" as const, text }, ...content],
    details: {
      node: target.nodeId,
      action: params.action,
      width: dimensions?.width,
      height: dimensions?.height,
      screenIndex: target.screenIndex,
      frameId,
      refWidth: params.referenceWidth,
      media: { outbound: false },
    },
  };
  return { result, frameId, imageIdentity: computerFrameImageIdentity(result.content) };
}

export async function projectComputerActResult(params: {
  result: ComputerActResult;
  target: ComputerTarget;
  action: ComputerToolAction;
  referenceWidth: number;
  modelHasVision?: boolean;
}): Promise<{
  result: AgentToolResult<unknown>;
  imageCoordinates?: ComputerObservationState["imageCoordinates"];
}> {
  const observation = params.result.observation;
  // Observation images have no context-presence tracking, so they must never be deduplicated.
  const { content, image, dimensions } = await projectComputerImage({
    ...params,
    image: observation?.base64
      ? {
          base64: observation.base64,
          mimeType: imageMimeFromFormat(observation.format ?? "png") ?? "image/png",
        }
      : undefined,
  });
  // Pixels belong only in image content. Metadata describes the delivered bitmap;
  // accessibility bounds retain the provider's coordinate space.
  const result = projectComputerActResultMetadata(params.result);
  if (result.observation && dimensions) {
    Object.assign(result.observation, dimensions, {
      format: image?.mimeType === "image/jpeg" ? "jpeg" : "png",
    });
  }
  let imageCoordinates: ComputerObservationState["imageCoordinates"];
  if (params.result.details?.coordinateSpace === "image-pixels") {
    imageCoordinates =
      dimensions && observation?.width && observation.height
        ? {
            kind: "available",
            scaleX: observation.width / dimensions.width,
            scaleY: observation.height / dimensions.height,
          }
        : { kind: "unavailable" };
  }
  return {
    result: {
      content: [
        { type: "text", text: JSON.stringify({ action: params.action, ...result }) },
        ...content,
      ],
      details: {
        node: params.target.nodeId,
        action: params.action,
        screenIndex: params.target.screenIndex,
        result,
        media: { outbound: false },
      },
    },
    imageCoordinates,
  };
}
