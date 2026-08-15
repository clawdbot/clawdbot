import { createHash, randomUUID } from "node:crypto";

export type CuaDesktopGeometry = {
  platform: string;
  display: string;
  screenWidth: number;
  screenHeight: number;
  scaleFactor: number;
  screenshotWidth: number;
  screenshotHeight: number;
};

export type CuaScreenSize = {
  width: number;
  height: number;
  scaleFactor: number;
};

export type CuaLastFrame = {
  id: string;
  nativeWidth: number;
  nativeHeight: number;
  deliveredWidth: number;
  deliveredHeight: number;
  geometry: CuaScreenSize;
};

export type CuaFrameState = {
  generation: string;
  lastFrame?: CuaLastFrame;
  apps?: Map<string, CuaAppTarget>;
  windows?: Map<string, CuaWindowTarget>;
  observation?: CuaObservationState;
  browsers?: Map<string, CuaBrowserTarget>;
  pages?: Map<string, CuaPageTarget>;
  browserObservation?: CuaBrowserObservationState;
  dialog?: CuaDialogState;
};

type CuaAppTarget = {
  pid?: number;
  name: string;
  bundleId?: string;
  launchPath?: string;
};

type CuaWindowTarget = {
  pid: number;
  windowId: number;
};

type CuaElementTarget = {
  elementIndex: number;
  elementToken?: string;
  snapshotId?: string;
};

type CuaObservationState = {
  id: string;
  windowRef: string;
  fromZoom: boolean;
  elements: Map<string, CuaElementTarget>;
};

type CuaBrowserTarget = {
  targetId: string;
  windowRef: string;
};

type CuaPageTarget = {
  browserRef: string;
  tabId: string;
};

type CuaBrowserElementTarget = {
  nativeRef: string;
};

type CuaBrowserObservationState = {
  id: string;
  browserRef: string;
  pageRef: string;
  elements: Map<string, CuaBrowserElementTarget>;
};

type CuaDialogState = {
  ref: string;
  nativeId: string;
  browserRef: string;
  pageRef: string;
};

function staleFrame(message: string): Error {
  return new Error(`COMPUTER_STALE_FRAME: ${message}; take a new screenshot`);
}

function staleObservation(): Error {
  return new Error("COMPUTER_STALE_OBSERVATION: take a fresh observation and retry");
}

function opaqueRef(
  kind: "app" | "window" | "observation" | "element" | "browser" | "page" | "dialog",
): string {
  return `cua:v2:${kind}:${randomUUID()}`;
}

export function adoptGeneration(state: CuaFrameState, generation: string): void {
  // Native session replacement invalidates every authority-bearing reference,
  // even when the same window ids and display geometry reappear.
  if (state.generation !== generation) {
    state.lastFrame = undefined;
    state.apps = undefined;
    state.windows = undefined;
    state.observation = undefined;
    state.browsers = undefined;
    state.pages = undefined;
    state.browserObservation = undefined;
    state.dialog = undefined;
  }
  state.generation = generation;
}

export function verifyGeneration(state: CuaFrameState, generation: string): void {
  if (state.generation !== generation) {
    adoptGeneration(state, generation);
    throw staleObservation();
  }
}

export function issueAppRef(state: CuaFrameState, target: CuaAppTarget): string {
  state.apps ??= new Map();
  const ref = opaqueRef("app");
  state.apps.set(ref, target);
  return ref;
}

export function resolveAppRef(state: CuaFrameState, ref: string): CuaAppTarget | undefined {
  return state.apps?.get(ref);
}

export function issueWindowRef(state: CuaFrameState, target: CuaWindowTarget): string {
  state.windows ??= new Map();
  for (const [ref, current] of state.windows) {
    if (current.pid === target.pid && current.windowId === target.windowId) {
      return ref;
    }
  }
  const ref = opaqueRef("window");
  state.windows.set(ref, target);
  return ref;
}

export function resolveWindowRef(state: CuaFrameState, ref: string): CuaWindowTarget {
  const target = state.windows?.get(ref);
  if (!target) {
    throw staleObservation();
  }
  return target;
}

export function issueObservation(
  state: CuaFrameState,
  windowRef: string,
  options: { fromZoom?: boolean } = {},
): CuaObservationState {
  // Only the newest observation may authorize element or window-pixel actions;
  // retaining older element tokens would bypass the driver's snapshot lifecycle.
  const observation: CuaObservationState = {
    id: opaqueRef("observation"),
    windowRef,
    fromZoom: options.fromZoom === true,
    elements: new Map(),
  };
  state.observation = observation;
  return observation;
}

export function issueElementRef(
  observation: CuaObservationState,
  target: CuaElementTarget,
): string {
  const ref = opaqueRef("element");
  observation.elements.set(ref, target);
  return ref;
}

export function resolveObservation(
  state: CuaFrameState,
  observationId: string,
  windowRef: string,
): CuaObservationState {
  const observation = state.observation;
  if (!observation || observation.id !== observationId || observation.windowRef !== windowRef) {
    throw staleObservation();
  }
  return observation;
}

export function resolveElementRef(
  observation: CuaObservationState,
  elementRef: string,
): CuaElementTarget {
  const target = observation.elements.get(elementRef);
  if (!target) {
    throw staleObservation();
  }
  return target;
}

export function issueBrowserRef(state: CuaFrameState, target: CuaBrowserTarget): string {
  state.browsers ??= new Map();
  for (const [ref, current] of state.browsers) {
    if (current.targetId === target.targetId && current.windowRef === target.windowRef) {
      return ref;
    }
  }
  const ref = opaqueRef("browser");
  state.browsers.set(ref, target);
  return ref;
}

export function resolveBrowserRef(state: CuaFrameState, ref: string): CuaBrowserTarget {
  const target = state.browsers?.get(ref);
  if (!target) {
    throw staleObservation();
  }
  return target;
}

export function issuePageRef(state: CuaFrameState, browserRef: string, tabId: string): string {
  state.pages ??= new Map();
  for (const [ref, current] of state.pages) {
    if (current.browserRef === browserRef && current.tabId === tabId) {
      return ref;
    }
  }
  const ref = opaqueRef("page");
  state.pages.set(ref, { browserRef, tabId });
  return ref;
}

export function resolvePageRef(
  state: CuaFrameState,
  browserRef: string,
  pageRef: string,
): CuaPageTarget {
  const page = state.pages?.get(pageRef);
  if (!page || page.browserRef !== browserRef) {
    throw staleObservation();
  }
  return page;
}

export function issueBrowserObservation(
  state: CuaFrameState,
  browserRef: string,
  pageRef: string,
): CuaBrowserObservationState {
  // CUA invalidates page refs after navigation and each newer snapshot. Keep
  // only the newest browser observation so stale DOM capabilities fail closed.
  const observation: CuaBrowserObservationState = {
    id: opaqueRef("observation"),
    browserRef,
    pageRef,
    elements: new Map(),
  };
  state.browserObservation = observation;
  state.dialog = undefined;
  return observation;
}

export function issueBrowserElementRef(
  observation: CuaBrowserObservationState,
  nativeRef: string,
): string {
  const ref = opaqueRef("element");
  observation.elements.set(ref, { nativeRef });
  return ref;
}

export function resolveBrowserObservation(
  state: CuaFrameState,
  observationId: string,
  browserRef: string,
  pageRef: string,
): CuaBrowserObservationState {
  const observation = state.browserObservation;
  if (
    !observation ||
    observation.id !== observationId ||
    observation.browserRef !== browserRef ||
    observation.pageRef !== pageRef
  ) {
    throw staleObservation();
  }
  return observation;
}

export function resolveBrowserElementRef(
  observation: CuaBrowserObservationState,
  elementRef: string,
): string {
  const target = observation.elements.get(elementRef);
  if (!target) {
    throw staleObservation();
  }
  return target.nativeRef;
}

export function invalidateBrowserObservation(state: CuaFrameState): void {
  state.browserObservation = undefined;
  state.dialog = undefined;
}

export function invalidateBrowserReferences(state: CuaFrameState): void {
  state.browsers = undefined;
  state.pages = undefined;
  invalidateBrowserObservation(state);
}

export function issueDialogRef(
  state: CuaFrameState,
  nativeId: string,
  browserRef: string,
  pageRef: string,
): string {
  const ref = opaqueRef("dialog");
  state.dialog = { ref, nativeId, browserRef, pageRef };
  return ref;
}

export function resolveDialogRef(
  state: CuaFrameState,
  dialogRef: string,
  browserRef: string,
  pageRef: string,
): string {
  const dialog = state.dialog;
  if (
    !dialog ||
    dialog.ref !== dialogRef ||
    dialog.browserRef !== browserRef ||
    dialog.pageRef !== pageRef
  ) {
    throw staleObservation();
  }
  return dialog.nativeId;
}

export function clearDialogRef(state: CuaFrameState): void {
  state.dialog = undefined;
}

/**
 * CUA Driver exposes only the primary-display label, not a stable display ID.
 * Bind authorization to connection generation plus the complete live geometry.
 */
export function issueFrame(
  state: CuaFrameState,
  geometry: CuaDesktopGeometry,
  delivered: { width: number; height: number },
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        state.generation,
        geometry.platform,
        geometry.display,
        geometry.screenWidth,
        geometry.screenHeight,
        geometry.scaleFactor,
        geometry.screenshotWidth,
        geometry.screenshotHeight,
      ]),
    )
    .digest("hex");
  const id = `cua:v1:${digest}`;
  state.lastFrame = {
    id,
    nativeWidth: geometry.screenshotWidth,
    nativeHeight: geometry.screenshotHeight,
    deliveredWidth: delivered.width,
    deliveredHeight: delivered.height,
    geometry: {
      width: geometry.screenWidth,
      height: geometry.screenHeight,
      scaleFactor: geometry.scaleFactor,
    },
  };
  return id;
}

// CUA Driver exposes no stable display identity, only "display":"primary".
// Verification therefore binds to this trusted-session generation plus full
// live geometry. A new session invalidates every frame; upstream has no signal
// for a same-geometry primary-display substitution inside one session.
export function verifyFrame(
  state: CuaFrameState,
  echoedId: string | undefined,
  currentScreenSize: CuaScreenSize,
): CuaLastFrame {
  const frame = state.lastFrame;
  if (!frame || !echoedId || echoedId !== frame.id) {
    state.lastFrame = undefined;
    throw staleFrame("the coordinate frame is missing or no longer current");
  }
  const geometryMatches =
    currentScreenSize.width === frame.geometry.width &&
    currentScreenSize.height === frame.geometry.height &&
    currentScreenSize.scaleFactor === frame.geometry.scaleFactor;
  if (!geometryMatches) {
    state.lastFrame = undefined;
    throw staleFrame("the primary display geometry changed");
  }
  return frame;
}

export function verifyReferenceWidth(
  state: CuaFrameState,
  frame: CuaLastFrame,
  refWidth: number | undefined,
): void {
  if (refWidth === frame.deliveredWidth) {
    return;
  }
  state.lastFrame = undefined;
  throw staleFrame("the coordinate reference width changed");
}
