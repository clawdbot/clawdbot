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
import type { CuaComputerActParams } from "./v2-actions.js";

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
