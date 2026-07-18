import { describe, expect, it } from "vitest";
import { MascotAnimator } from "./mascot-animator.ts";
import { staticMascotPose, type MascotMood, type MascotPose } from "./mascot-pose.ts";

const MOODS: MascotMood[] = [
  "idle",
  "curious",
  "thinking",
  "working",
  "happy",
  "celebrating",
  "sad",
  "sleepy",
  "attentive",
];

function expectPoseInBounds(pose: MascotPose): void {
  expect(pose.floatOffset).toBeGreaterThanOrEqual(-12);
  expect(pose.floatOffset).toBeLessThanOrEqual(2);
  expect(pose.antennaDegrees).toBeGreaterThanOrEqual(-14);
  expect(pose.antennaDegrees).toBeLessThanOrEqual(14);
  expect(pose.antennaDroop).toBeGreaterThanOrEqual(0);
  expect(pose.antennaDroop).toBeLessThanOrEqual(1);
  expect(pose.leftClawDegrees).toBeGreaterThanOrEqual(-45);
  expect(pose.leftClawDegrees).toBeLessThanOrEqual(45);
  expect(pose.rightClawDegrees).toBeGreaterThanOrEqual(-45);
  expect(pose.rightClawDegrees).toBeLessThanOrEqual(45);
  expect(pose.eyeGlowOpacity).toBeGreaterThanOrEqual(0);
  expect(pose.eyeGlowOpacity).toBeLessThanOrEqual(1);
  expect(pose.glowScale).toBeGreaterThanOrEqual(0.5);
  expect(pose.glowScale).toBeLessThanOrEqual(1.6);
  expect(pose.leftEyeOpenness).toBeGreaterThanOrEqual(0);
  expect(pose.leftEyeOpenness).toBeLessThanOrEqual(1);
  expect(pose.rightEyeOpenness).toBeGreaterThanOrEqual(0);
  expect(pose.rightEyeOpenness).toBeLessThanOrEqual(1);
  expect(pose.happyEyes).toBeGreaterThanOrEqual(0);
  expect(pose.happyEyes).toBeLessThanOrEqual(1);
  expect(pose.gaze.x).toBeGreaterThanOrEqual(-1.2);
  expect(pose.gaze.x).toBeLessThanOrEqual(1.2);
  expect(pose.gaze.y).toBeGreaterThanOrEqual(-1.2);
  expect(pose.gaze.y).toBeLessThanOrEqual(1.2);
  expect(pose.mouthCurve).toBeGreaterThanOrEqual(-1);
  expect(pose.mouthCurve).toBeLessThanOrEqual(1);
  expect(pose.mouthOpen).toBeGreaterThanOrEqual(0);
  expect(pose.mouthOpen).toBeLessThanOrEqual(1);
  expect(pose.mouthRound).toBeGreaterThanOrEqual(0);
  expect(pose.mouthRound).toBeLessThanOrEqual(1);
  expect(pose.blush).toBeGreaterThanOrEqual(0);
  expect(pose.blush).toBeLessThanOrEqual(1);
  expect(pose.hardHat).toBeGreaterThanOrEqual(0);
  expect(pose.hardHat).toBeLessThanOrEqual(1);
  expect(pose.bodyTilt).toBeGreaterThanOrEqual(-8);
  expect(pose.bodyTilt).toBeLessThanOrEqual(8);
  expect(pose.bodyStretch).toBeGreaterThanOrEqual(0.86);
  expect(pose.bodyStretch).toBeLessThanOrEqual(1.05);
  expect(pose.dizzy).toBeGreaterThanOrEqual(0);
  expect(pose.dizzy).toBeLessThanOrEqual(1);
}

describe("MascotAnimator", () => {
  it("keeps every mood inside drawable channel bounds for 30 seconds", () => {
    for (const [index, mood] of MOODS.entries()) {
      const animator = new MascotAnimator(1_000 + index);
      animator.setMood(mood, 0);
      for (let frame = 0; frame <= 30 * 30; frame += 1) {
        expectPoseInBounds(animator.poseAt(frame / 30));
      }
    }
  });

  it("produces identical pose streams from the same seed", () => {
    const first = new MascotAnimator(0x5eed);
    const second = new MascotAnimator(0x5eed);
    first.setMood("thinking", 0);
    second.setMood("thinking", 0);

    for (let frame = 0; frame <= 20 * 30; frame += 1) {
      const time = frame / 30;
      expect(first.poseAt(time)).toEqual(second.poseAt(time));
    }
  });

  it("runs the working hard-hat, hammer, impact, and brow-wipe cycle", () => {
    const animator = new MascotAnimator(42);
    animator.setMood("working", 0);
    const rightClawAngles: number[] = [];
    const effects = new Set<string>();
    let seatedHat = 0;

    for (let frame = 0; frame <= 30 * 30; frame += 1) {
      const pose = animator.poseAt(frame / 30);
      rightClawAngles.push(pose.rightClawDegrees);
      effects.add(pose.effect);
      if (frame >= 33) {
        seatedHat = Math.max(seatedHat, pose.hardHat);
      }
    }

    expect(seatedHat).toBe(1);
    expect(Math.max(...rightClawAngles) - Math.min(...rightClawAngles)).toBeGreaterThan(25);
    expect(effects).toContain("sparks");
    expect(effects).toContain("sweat");
  });

  it("cancels stale gestures when the mood changes", () => {
    // Begin as idle (queues the hello wave at +0.9s), then switch mood before
    // it fires — mirrors the element lifecycle where firstUpdated precedes the
    // first `updated()` mood application.
    const animator = new MascotAnimator(9);
    animator.poseAt(0);
    animator.setMood("thinking", 0.1);

    for (let frame = 3; frame <= 4 * 30; frame += 1) {
      const pose = animator.poseAt(frame / 30);
      // The wave raises the right claw far past anything thinking's base loop
      // (claw ~0°) or a scheduled claw snap (-8°) can produce.
      expect(pose.rightClawDegrees).toBeGreaterThan(-15);
    }
  });

  it("keeps sleepy z's visible through its yawn entrance", () => {
    const animator = new MascotAnimator(7);
    animator.setMood("sleepy", 0);
    const pose = animator.poseAt(0.8);

    expect(pose.effect).toBe("zzz");
    expect(pose.mouthRound).toBeGreaterThan(0.8);
    expect(pose.leftEyeOpenness).toBeLessThan(0.1);
  });

  it("overlays and clears the composer tease expression", () => {
    const animator = new MascotAnimator(17);
    animator.setMood("idle", 0);
    animator.setTease(true, 0);

    expect(animator.poseAt(0)).toMatchObject({ mouthRound: 0.5, gaze: { x: 0, y: 0.6 } });

    animator.setTease(false, 0.1);
    const cleared = animator.poseAt(0.1);
    expect(cleared.mouthRound).toBe(0);
    expect(cleared.gaze).not.toEqual({ x: 0, y: 0.6 });
  });

  it("plays one bounded catch beat and clears it after 0.8 seconds", () => {
    const animator = new MascotAnimator(23);
    animator.setMood("idle", 0);
    animator.poseAt(0);
    animator.playCatch(0.1);

    let peakHappyEyes = 0;
    for (let frame = 0; frame <= 24; frame += 1) {
      const pose = animator.poseAt(0.1 + frame / 30);
      expectPoseInBounds(pose);
      peakHappyEyes = Math.max(peakHappyEyes, pose.happyEyes);
    }
    expect(peakHappyEyes).toBeGreaterThan(0.8);
    expect(animator.poseAt(0.91).happyEyes).toBe(0);
    expect(animator.poseAt(1.2).happyEyes).toBe(0);
  });
});

describe("staticMascotPose", () => {
  it("preserves the identifying expression for each motionless mood", () => {
    expect(staticMascotPose("thinking").gaze.y).toBeLessThan(0);
    expect(staticMascotPose("working")).toMatchObject({ hardHat: 1, rightClawDegrees: -28 });
    expect(staticMascotPose("happy").mouthCurve).toBeGreaterThan(0.5);
    expect(staticMascotPose("celebrating").leftClawDegrees).toBeGreaterThan(25);
    expect(staticMascotPose("celebrating").rightClawDegrees).toBeLessThan(-25);
    expect(staticMascotPose("sad")).toMatchObject({ antennaDroop: 0.75, mouthCurve: -0.55 });
    expect(staticMascotPose("sleepy").leftEyeOpenness).toBe(0.25);
    expect(staticMascotPose("attentive")).toEqual(staticMascotPose("idle"));
  });
});
