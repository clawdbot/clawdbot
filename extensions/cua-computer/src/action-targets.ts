import type { ComputerActParams } from "openclaw/plugin-sdk/computer-use";
import type { CuaDriverSession } from "./driver-client.js";
import {
  resolveBrowserElementRef,
  resolveBrowserObservation,
  resolveBrowserRef,
  resolveElementRef,
  resolveObservation,
  resolvePageRef,
  resolveWindowRef,
  verifyGeneration,
  type CuaFrameState,
} from "./frame.js";

export type CuaComputerActParams = {
  action: ComputerActParams["action"];
  executionId?: string;
  displayFrameId?: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  text?: string;
  keys?: string;
  modifiers?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  durationMs?: number;
  screenIndex?: number;
  refWidth?: number;
  windowRef?: string;
  elementRef?: string;
  observationId?: string;
  deliveryMode?: "background" | "foreground";
  query?: string;
  depth?: number;
  maxElements?: number;
  app?: string;
  value?: string;
  path?: string[];
  browserRef?: string;
  pageRef?: string;
  snapshotFormat?: "dom_refs_v1" | "semantic_v2";
  continuation?: string;
  includeScreenshot?: boolean;
  profile?: "isolated_new" | "isolated_named";
  profileName?: string;
  url?: string;
  inputRoute?: "trusted" | "dom_event";
  mode?: "insert_text" | "keystrokes";
  replace?: boolean;
  dialogAction?: "inspect" | "accept" | "dismiss";
  dialogRef?: string;
  promptText?: string;
  resourceHandle?: string;
  resourceHandles?: string[];
  recordVideo?: boolean;
  delayMs?: number;
  stopOnError?: boolean;
  pointerAction?: "hover" | "right_click" | "double_click" | "scroll" | "drag";
  destinationElementRef?: string;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  reason?:
    | "ax_tree_pixel_mismatch"
    | "background_delivery_failed"
    | "foreground_ineffective"
    | "no_window_target"
    | "other";
};

export function requireWindowTarget(
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: CuaComputerActParams,
) {
  verifyGeneration(state, driver.generation);
  if (!params.windowRef) {
    throw new Error(`COMPUTER_INVALID_REQUEST: windowRef is required for ${params.action}`);
  }
  return {
    ref: params.windowRef,
    target: resolveWindowRef(state, params.windowRef),
  };
}

function observationTarget(state: CuaFrameState, params: CuaComputerActParams, windowRef: string) {
  if (!params.observationId) {
    throw new Error(`COMPUTER_STALE_OBSERVATION: observationId is required for ${params.action}`);
  }
  return resolveObservation(state, params.observationId, windowRef);
}

export function elementArgs(
  state: CuaFrameState,
  params: CuaComputerActParams,
  windowRef: string,
): Record<string, unknown> | undefined {
  if (!params.elementRef) {
    return undefined;
  }
  const observation = observationTarget(state, params, windowRef);
  const element = resolveElementRef(observation, params.elementRef);
  return element.elementToken
    ? { element_token: element.elementToken }
    : {
        element_index: element.elementIndex,
        ...(element.snapshotId ? { snapshot_id: element.snapshotId } : {}),
      };
}

export function browserTarget(
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: CuaComputerActParams,
) {
  verifyGeneration(state, driver.generation);
  if (!params.browserRef || !params.pageRef) {
    throw new Error(
      `COMPUTER_INVALID_REQUEST: browserRef and pageRef are required for ${params.action}`,
    );
  }
  const browser = resolveBrowserRef(state, params.browserRef);
  const page = resolvePageRef(state, params.browserRef, params.pageRef);
  return {
    browserRef: params.browserRef,
    pageRef: params.pageRef,
    targetId: browser.targetId,
    tabId: page.tabId,
  };
}

export function browserElement(
  state: CuaFrameState,
  params: CuaComputerActParams,
  target: { browserRef: string; pageRef: string },
  elementRef = params.elementRef,
): string | undefined {
  if (!elementRef) {
    return undefined;
  }
  if (!params.observationId) {
    throw new Error(`COMPUTER_STALE_OBSERVATION: observationId is required for ${params.action}`);
  }
  const observation = resolveBrowserObservation(
    state,
    params.observationId,
    target.browserRef,
    target.pageRef,
  );
  return resolveBrowserElementRef(observation, elementRef);
}

export function windowPointArgs(
  state: CuaFrameState,
  params: CuaComputerActParams,
  windowRef: string,
  point: { x?: number; y?: number },
  label: string,
): Record<string, unknown> {
  if (point.x === undefined || point.y === undefined) {
    throw new Error(`COMPUTER_INVALID_REQUEST: ${label} coordinates are required`);
  }
  const observation = observationTarget(state, params, windowRef);
  return {
    x: point.x,
    y: point.y,
    ...(observation.fromZoom ? { from_zoom: true } : {}),
  };
}
