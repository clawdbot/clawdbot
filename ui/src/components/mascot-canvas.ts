/* oxlint-disable unicorn/no-array-fill-with-reference-type -- CanvasRenderingContext2D.fill is not Array.fill. */
// Canvas-only rendering for the canonical 120x120 Clawd vector.
import type { MascotPalette, MascotPose } from "./mascot-pose.ts";

const ART_SIZE = 120;
const TAU = Math.PI * 2;
const EYE = "#050810";
const EYE_GLOW = "#00e5cc";
const BLUSH = "#ff9eae";
const HAT_AMBER = "#f2a833";
const HAT_LIGHT = "#ffd659";
const HAT_OUTLINE = "rgba(184, 115, 31, 0.7)";

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Shape = { path: Path2D; bounds: Bounds };
type MascotPaths = {
  body: Shape;
  leftClaw: Shape;
  rightClaw: Shape;
  leftAntenna: Path2D;
  rightAntenna: Path2D;
};

let cachedPaths: MascotPaths | null = null;

function mascotPaths(): MascotPaths {
  if (cachedPaths) {
    return cachedPaths;
  }

  const body = new Path2D();
  body.moveTo(60, 10);
  body.bezierCurveTo(30, 10, 15, 35, 15, 55);
  body.bezierCurveTo(15, 75, 30, 95, 45, 100);
  body.lineTo(45, 110);
  body.lineTo(55, 110);
  body.lineTo(55, 100);
  body.bezierCurveTo(55, 100, 60, 102, 65, 100);
  body.lineTo(65, 110);
  body.lineTo(75, 110);
  body.lineTo(75, 100);
  body.bezierCurveTo(90, 95, 105, 75, 105, 55);
  body.bezierCurveTo(105, 35, 90, 10, 60, 10);
  body.closePath();

  const leftClaw = new Path2D();
  leftClaw.moveTo(20, 45);
  leftClaw.bezierCurveTo(5, 40, 0, 50, 5, 60);
  leftClaw.bezierCurveTo(10, 70, 20, 65, 25, 55);
  leftClaw.bezierCurveTo(28, 48, 25, 45, 20, 45);
  leftClaw.closePath();

  const rightClaw = new Path2D();
  rightClaw.moveTo(100, 45);
  rightClaw.bezierCurveTo(115, 40, 120, 50, 115, 60);
  rightClaw.bezierCurveTo(110, 70, 100, 65, 95, 55);
  rightClaw.bezierCurveTo(92, 48, 95, 45, 100, 45);
  rightClaw.closePath();

  const leftAntenna = new Path2D();
  leftAntenna.moveTo(45, 15);
  leftAntenna.quadraticCurveTo(35, 5, 30, 8);

  const rightAntenna = new Path2D();
  rightAntenna.moveTo(75, 15);
  rightAntenna.quadraticCurveTo(85, 5, 90, 8);

  cachedPaths = {
    body: { path: body, bounds: { minX: 15, minY: 10, maxX: 105, maxY: 110 } },
    leftClaw: {
      path: leftClaw,
      bounds: {
        minX: 3.125,
        minY: 43.670_068_381_445_48,
        maxX: 26.196_938_456_699_073,
        maxY: 65.450_849_718_747_38,
      },
    },
    rightClaw: {
      path: rightClaw,
      bounds: {
        minX: 93.803_061_543_300_93,
        minY: 43.670_068_381_445_48,
        maxX: 116.875,
        maxY: 65.450_849_718_747_38,
      },
    },
    leftAntenna,
    rightAntenna,
  };
  return cachedPaths;
}

function gradient(ctx: CanvasRenderingContext2D, shape: Shape, palette: MascotPalette) {
  const { bounds } = shape;
  const fill = ctx.createLinearGradient(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  fill.addColorStop(0, palette.gradientTop);
  fill.addColorStop(1, palette.gradientBottom);
  return fill;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function easeInOut(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function bell(value: number): number {
  const t = clamp(value, 0, 1);
  return easeInOut(t < 0.5 ? t * 2 : (1 - t) * 2);
}

function rotated(
  ctx: CanvasRenderingContext2D,
  degrees: number,
  pivot: Point,
  draw: () => void,
): void {
  ctx.save();
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate(radians(degrees));
  ctx.translate(-pivot.x, -pivot.y);
  draw();
  ctx.restore();
}

function ellipsePath(center: Point, radiusX: number, radiusY: number): Path2D {
  const path = new Path2D();
  path.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, TAU);
  return path;
}

function roundedRectPath(x: number, y: number, width: number, height: number, radius: number) {
  const path = new Path2D();
  const right = x + width;
  const bottom = y + height;
  path.moveTo(x + radius, y);
  path.lineTo(right - radius, y);
  path.quadraticCurveTo(right, y, right, y + radius);
  path.lineTo(right, bottom - radius);
  path.quadraticCurveTo(right, bottom, right - radius, bottom);
  path.lineTo(x + radius, bottom);
  path.quadraticCurveTo(x, bottom, x, bottom - radius);
  path.lineTo(x, y + radius);
  path.quadraticCurveTo(x, y, x + radius, y);
  path.closePath();
  return path;
}

function drawEye(ctx: CanvasRenderingContext2D, center: Point, openness: number, pose: MascotPose) {
  const shifted = {
    x: center.x + pose.gaze.x * 2,
    y: center.y + pose.gaze.y * 1.5,
  };

  if (pose.happyEyes < 1) {
    const height = Math.max(1.2, 12 * openness * (1 - 0.6 * pose.happyEyes));
    ctx.save();
    ctx.globalAlpha *= 1 - pose.happyEyes;
    ctx.fillStyle = EYE;
    ctx.fill(
      ellipsePath(
        { x: shifted.x, y: shifted.y - 6 + (12 - height) * 0.65 + height / 2 },
        6,
        height / 2,
      ),
    );
    ctx.restore();
  }

  if (pose.happyEyes > 0) {
    const arc = new Path2D();
    arc.moveTo(shifted.x - 6, shifted.y + 2);
    arc.quadraticCurveTo(shifted.x, shifted.y - 5.5, shifted.x + 6, shifted.y + 2);
    ctx.save();
    ctx.globalAlpha *= pose.happyEyes;
    ctx.strokeStyle = EYE;
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.stroke(arc);
    ctx.restore();
  }

  if (pose.dizzy > 0) {
    const angle = pose.dizzyPhase * TAU + (center.x > 60 ? Math.PI : 0);
    const dot = {
      x: shifted.x + Math.cos(angle) * 3.4,
      y: shifted.y + Math.sin(angle) * 2.6,
    };
    ctx.save();
    ctx.globalAlpha *= pose.dizzy;
    ctx.fillStyle = EYE_GLOW;
    ctx.fill(ellipsePath(dot, 1.8, 1.8));
    ctx.restore();
  }

  const glowVisibility = pose.eyeGlowOpacity * openness * (1 - pose.happyEyes) * (1 - pose.dizzy);
  if (glowVisibility <= 0.01) {
    return;
  }
  const glowRadius = 2 * pose.glowScale;
  const glowCenter = {
    x: shifted.x + 1 + pose.gaze.x * 1.2,
    y: shifted.y - 1 + pose.gaze.y * 0.9,
  };
  ctx.save();
  ctx.globalAlpha *= glowVisibility;
  ctx.fillStyle = EYE_GLOW;
  ctx.fill(ellipsePath(glowCenter, glowRadius, glowRadius));
  ctx.restore();
}

function drawMouth(ctx: CanvasRenderingContext2D, pose: MascotPose): void {
  ctx.fillStyle = EYE;
  ctx.strokeStyle = EYE;
  ctx.lineCap = "round";
  if (pose.mouthRound > 0.05) {
    const radiusX = 1 + 3.2 * pose.mouthRound;
    const radiusY = 1 + 4.2 * pose.mouthRound;
    ctx.fill(ellipsePath({ x: 60, y: 51 }, radiusX, radiusY));
    return;
  }
  if (pose.mouthOpen > 0.05) {
    const grin = new Path2D();
    grin.moveTo(52.5, 48.5);
    grin.quadraticCurveTo(60, 48.5 + 14 * pose.mouthOpen, 67.5, 48.5);
    grin.closePath();
    ctx.fill(grin);
    return;
  }
  if (Math.abs(pose.mouthCurve) <= 0.05) {
    return;
  }
  const curve = new Path2D();
  curve.moveTo(52.5, 49);
  curve.quadraticCurveTo(60, 49 + 8 * pose.mouthCurve, 67.5, 49);
  ctx.lineWidth = 2.2;
  ctx.stroke(curve);
}

function drawBlush(ctx: CanvasRenderingContext2D, pose: MascotPose): void {
  if (pose.blush <= 0.02) {
    return;
  }
  ctx.save();
  ctx.globalAlpha *= pose.blush * 0.55;
  ctx.fillStyle = BLUSH;
  ctx.fill(ellipsePath({ x: 37, y: 45 }, 4.5, 2.5));
  ctx.fill(ellipsePath({ x: 83, y: 45 }, 4.5, 2.5));
  ctx.restore();
}

function drawHardHat(ctx: CanvasRenderingContext2D, amount: number): void {
  if (amount <= 0.01) {
    return;
  }
  const dome = new Path2D();
  dome.moveTo(45, 15);
  dome.bezierCurveTo(47, 7, 54, 3, 60, 3);
  dome.bezierCurveTo(66, 3, 73, 7, 75, 15);
  dome.lineTo(45, 15);
  dome.closePath();
  const brim = roundedRectPath(41, 14, 38, 5, 2);

  ctx.save();
  ctx.globalAlpha *= amount;
  ctx.translate(60, 15 - 14 * (1 - amount));
  ctx.rotate(radians(-5));
  ctx.translate(-60, -15);
  const fill = ctx.createLinearGradient(60, 3, 60, 16);
  fill.addColorStop(0, HAT_LIGHT);
  fill.addColorStop(1, HAT_AMBER);
  ctx.fillStyle = fill;
  ctx.fill(dome);
  ctx.strokeStyle = HAT_OUTLINE;
  ctx.lineWidth = 0.8;
  ctx.stroke(dome);
  ctx.fillStyle = HAT_AMBER;
  ctx.fill(brim);
  ctx.stroke(brim);
  ctx.restore();
}

function sparklePath(center: Point, size: number): Path2D {
  const path = new Path2D();
  path.moveTo(center.x, center.y - size);
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const) {
    path.quadraticCurveTo(center.x, center.y, center.x + size * dx, center.y + size * dy);
  }
  path.closePath();
  return path;
}

function drawZ(ctx: CanvasRenderingContext2D, position: Point, size: number, alpha: number): void {
  const path = new Path2D();
  const width = size * 0.62;
  const height = size * 0.78;
  path.moveTo(position.x - width / 2, position.y - height / 2);
  path.lineTo(position.x + width / 2, position.y - height / 2);
  path.lineTo(position.x - width / 2, position.y + height / 2);
  path.lineTo(position.x + width / 2, position.y + height / 2);
  ctx.save();
  ctx.globalAlpha *= alpha * 0.9;
  ctx.strokeStyle = EYE_GLOW;
  ctx.lineWidth = Math.max(1.2, size * 0.16);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

function drawEffect(ctx: CanvasRenderingContext2D, pose: MascotPose, palette: MascotPalette): void {
  switch (pose.effect) {
    case "none":
      return;
    case "sparkles":
      for (let index = 0; index < 6; index += 1) {
        const phase = (pose.effectPhase + index * 0.37) % 1;
        const alpha = bell(phase);
        if (alpha <= 0.05) {
          continue;
        }
        const angle = Math.PI + (Math.PI * (index + 0.5)) / 6;
        const center = {
          x: 60 + Math.cos(angle) * (50 + (index % 3) * 4),
          y: 55 + Math.sin(angle) * (40 + ((index * 5) % 3) * 4),
        };
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.fillStyle = index % 2 === 0 ? EYE_GLOW : palette.antenna;
        ctx.fill(sparklePath(center, 2.5 + 2 * alpha));
        ctx.restore();
      }
      return;
    case "zzz":
      for (let index = 0; index < 3; index += 1) {
        const phase = (pose.effectPhase + index * 0.33) % 1;
        const alpha = phase < 0.2 ? phase / 0.2 : 1 - (phase - 0.2) / 0.8;
        if (alpha <= 0.05) {
          continue;
        }
        drawZ(
          ctx,
          {
            x: 86 + 14 * phase + 2 * Math.sin(phase * 4 * Math.PI),
            y: 24 - 20 * phase,
          },
          6 + 4 * phase,
          alpha,
        );
      }
      return;
    case "sparks":
      for (let index = 0; index < 5; index += 1) {
        const rawPhase = pose.effectPhase - index * 0.025;
        if (rawPhase < 0 || rawPhase >= 0.45) {
          continue;
        }
        const alpha = rawPhase < 0.08 ? rawPhase / 0.08 : 1 - (rawPhase - 0.08) / 0.37;
        const angle = radians(-160 + index * 35);
        const radius = 5 + (12 * rawPhase) / 0.45;
        const particleSize = 2.2 + (index % 3) * 0.8;
        const center = {
          x: clamp(106 + Math.cos(angle) * radius, particleSize, ART_SIZE - particleSize),
          y: clamp(66 + Math.sin(angle) * radius, particleSize, ART_SIZE - particleSize),
        };
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.fillStyle = index % 2 === 0 ? EYE_GLOW : HAT_AMBER;
        ctx.fill(sparklePath(center, particleSize));
        ctx.restore();
      }
      return;
    case "sweat": {
      const alpha = bell(pose.effectPhase);
      if (alpha <= 0.02) {
        return;
      }
      const center = { x: 42, y: 24 + 7 * pose.effectPhase };
      const drop = new Path2D();
      drop.moveTo(center.x, center.y - 3);
      drop.bezierCurveTo(
        center.x - 4,
        center.y + 1,
        center.x - 2,
        center.y + 3,
        center.x,
        center.y + 3,
      );
      drop.bezierCurveTo(
        center.x + 2,
        center.y + 3,
        center.x + 4,
        center.y + 1,
        center.x,
        center.y - 3,
      );
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = "#80d4ff";
      ctx.fill(drop);
      ctx.restore();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Draw one pose. Whole-body float is applied by the host to avoid canvas clipping. */
export function drawMascot(
  pose: MascotPose,
  palette: MascotPalette,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const paths = mascotPaths();
  ctx.save();
  ctx.scale(size / ART_SIZE, size / ART_SIZE);

  if (pose.bodyStretch !== 1) {
    const stretchX = clamp(1 + (1 - pose.bodyStretch) * 0.5, 0.97, 1.03);
    ctx.translate(60, 110);
    ctx.scale(stretchX, pose.bodyStretch);
    ctx.translate(-60, -110);
  }
  if (pose.bodyTilt !== 0) {
    ctx.translate(60, 60);
    ctx.rotate(radians(pose.bodyTilt));
    ctx.translate(-60, -60);
  }

  ctx.fillStyle = gradient(ctx, paths.body, palette);
  ctx.fill(paths.body.path);
  rotated(ctx, pose.leftClawDegrees, { x: 26, y: 53 }, () => {
    ctx.fillStyle = gradient(ctx, paths.leftClaw, palette);
    ctx.fill(paths.leftClaw.path);
  });
  rotated(ctx, pose.rightClawDegrees, { x: 94, y: 53 }, () => {
    ctx.fillStyle = gradient(ctx, paths.rightClaw, palette);
    ctx.fill(paths.rightClaw.path);
  });

  const wiggle = pose.antennaDegrees * (1 - pose.antennaDroop);
  ctx.strokeStyle = palette.antenna;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  rotated(ctx, -pose.antennaDroop * 40, { x: 45, y: 15 }, () => {
    rotated(ctx, wiggle, { x: 37.5, y: 11 }, () => ctx.stroke(paths.leftAntenna));
  });
  rotated(ctx, pose.antennaDroop * 40, { x: 75, y: 15 }, () => {
    rotated(ctx, wiggle, { x: 82.5, y: 11 }, () => ctx.stroke(paths.rightAntenna));
  });

  drawHardHat(ctx, pose.hardHat);
  drawBlush(ctx, pose);
  drawEye(ctx, { x: 45, y: 35 }, pose.leftEyeOpenness, pose);
  drawEye(ctx, { x: 75, y: 35 }, pose.rightEyeOpenness, pose);
  drawMouth(ctx, pose);
  drawEffect(ctx, pose, palette);
  ctx.restore();
}
