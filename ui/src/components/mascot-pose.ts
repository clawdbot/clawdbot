// Pure pose model shared by the mascot animator and canvas renderer.

export type MascotMood =
  | "idle"
  | "curious"
  | "thinking"
  | "working"
  | "happy"
  | "celebrating"
  | "sad"
  | "sleepy"
  | "attentive";

type MascotEffect = "none" | "sparkles" | "zzz" | "sparks" | "sweat";

export type MascotPose = {
  floatOffset: number;
  antennaDegrees: number;
  antennaDroop: number;
  leftClawDegrees: number;
  rightClawDegrees: number;
  eyeGlowOpacity: number;
  glowScale: number;
  leftEyeOpenness: number;
  rightEyeOpenness: number;
  happyEyes: number;
  gaze: { x: number; y: number };
  mouthCurve: number;
  mouthOpen: number;
  mouthRound: number;
  blush: number;
  hardHat: number;
  bodyTilt: number;
  bodyStretch: number;
  dizzy: number;
  dizzyPhase: number;
  effect: MascotEffect;
  effectPhase: number;
};

export type MascotPalette = {
  gradientTop: string;
  gradientBottom: string;
  antenna: string;
};

const DARK_PALETTE: MascotPalette = {
  gradientTop: "#ff4d4d",
  gradientBottom: "#991b1b",
  antenna: "#ff4d4d",
};

const LIGHT_PALETTE: MascotPalette = {
  gradientTop: "#ff7079",
  gradientBottom: "#ea4c59",
  antenna: "#ef4b58",
};

export function createMascotPose(): MascotPose {
  return {
    floatOffset: 0,
    antennaDegrees: 0,
    antennaDroop: 0,
    leftClawDegrees: 0,
    rightClawDegrees: 0,
    eyeGlowOpacity: 1,
    glowScale: 1,
    leftEyeOpenness: 1,
    rightEyeOpenness: 1,
    happyEyes: 0,
    gaze: { x: 0, y: 0 },
    mouthCurve: 0,
    mouthOpen: 0,
    mouthRound: 0,
    blush: 0,
    hardHat: 0,
    bodyTilt: 0,
    bodyStretch: 1,
    dizzy: 0,
    dizzyPhase: 0,
    effect: "none",
    effectPhase: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keep every channel inside the drawable 120x120 art-space bounds. */
export function clampMascotPose(pose: MascotPose): MascotPose {
  pose.floatOffset = clamp(pose.floatOffset, -12, 2);
  pose.antennaDegrees = clamp(pose.antennaDegrees, -14, 14);
  pose.antennaDroop = clamp(pose.antennaDroop, 0, 1);
  pose.leftClawDegrees = clamp(pose.leftClawDegrees, -45, 45);
  pose.rightClawDegrees = clamp(pose.rightClawDegrees, -45, 45);
  pose.eyeGlowOpacity = clamp(pose.eyeGlowOpacity, 0, 1);
  pose.glowScale = clamp(pose.glowScale, 0.5, 1.6);
  pose.leftEyeOpenness = clamp(pose.leftEyeOpenness, 0, 1);
  pose.rightEyeOpenness = clamp(pose.rightEyeOpenness, 0, 1);
  pose.happyEyes = clamp(pose.happyEyes, 0, 1);
  pose.gaze.x = clamp(pose.gaze.x, -1.2, 1.2);
  pose.gaze.y = clamp(pose.gaze.y, -1.2, 1.2);
  pose.mouthCurve = clamp(pose.mouthCurve, -1, 1);
  pose.mouthOpen = clamp(pose.mouthOpen, 0, 1);
  pose.mouthRound = clamp(pose.mouthRound, 0, 1);
  pose.blush = clamp(pose.blush, 0, 1);
  pose.hardHat = clamp(pose.hardHat, 0, 1);
  pose.bodyTilt = clamp(pose.bodyTilt, -8, 8);
  pose.bodyStretch = clamp(pose.bodyStretch, 0.86, 1.05);
  pose.dizzy = clamp(pose.dizzy, 0, 1);
  return pose;
}

/** Motionless mood expression used when reduced motion is requested. */
export function staticMascotPose(mood: MascotMood): MascotPose {
  const pose = createMascotPose();
  switch (mood) {
    case "idle":
    case "curious":
    case "attentive":
      break;
    case "thinking":
      pose.gaze = { x: 0.3, y: -0.5 };
      break;
    case "working":
      pose.hardHat = 1;
      pose.rightClawDegrees = -28;
      pose.gaze = { x: 0.4, y: 0.35 };
      pose.mouthCurve = 0.15;
      pose.bodyTilt = 2;
      break;
    case "happy":
      pose.mouthCurve = 0.6;
      pose.happyEyes = 0.4;
      break;
    case "celebrating":
      pose.mouthCurve = 0.9;
      pose.mouthOpen = 0.4;
      pose.happyEyes = 0.8;
      pose.leftClawDegrees = 30;
      pose.rightClawDegrees = -30;
      break;
    case "sad":
      pose.antennaDroop = 0.75;
      pose.mouthCurve = -0.55;
      pose.eyeGlowOpacity = 0.6;
      pose.gaze = { x: 0, y: 0.5 };
      break;
    case "sleepy":
      pose.leftEyeOpenness = 0.25;
      pose.rightEyeOpenness = 0.25;
      pose.eyeGlowOpacity = 0.5;
      pose.antennaDroop = 0.35;
      break;
  }
  return pose;
}

export function mascotPalette(light: boolean): MascotPalette {
  return light ? LIGHT_PALETTE : DARK_PALETTE;
}
