import { createHash } from "node:crypto";

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
};

function staleFrame(message: string): Error {
  return new Error(`COMPUTER_STALE_FRAME: ${message}; take a new screenshot`);
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
