// Pure deterministic mascot motion model. Times are seconds.
import {
  clampMascotPose,
  createMascotPose,
  type MascotMood,
  type MascotPose,
} from "./mascot-pose.ts";

type Gesture =
  | "wave"
  | "hop"
  | "celebrate"
  | "sigh"
  | "yawn"
  | "clawSnap"
  | "donHardHat"
  | "wipeBrow";

const MASK_64 = (1n << 64n) - 1n;
const NONZERO_SEED = 0x9e37_79b9_7f4a_7c15n;
const XORSHIFT_MULTIPLIER = 2_685_821_657_736_338_717n;
const TAU = Math.PI * 2;
const BLINK_DURATION = 0.16;
const CATCH_DURATION = 0.8;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max);
}

function cyclePhase(time: number, period: number): number {
  const normalized = (time / period) % 1;
  return normalized < 0 ? normalized + 1 : normalized;
}

function easeInOut(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function bell(value: number): number {
  const t = clamp(value);
  return easeInOut(t < 0.5 ? t * 2 : (1 - t) * 2);
}

function plateau(value: number, attack: number, release: number): number {
  const t = clamp(value);
  if (t < attack) {
    return easeInOut(t / attack);
  }
  if (t > release) {
    return easeInOut((1 - t) / (1 - release));
  }
  return 1;
}

function gestureDuration(gesture: Gesture): number {
  switch (gesture) {
    case "wave":
      return 1.5;
    case "hop":
      return 0.7;
    case "celebrate":
      return 2.4;
    case "sigh":
      return 1.8;
    case "yawn":
    case "wipeBrow":
      return 2;
    case "clawSnap":
      return 0.6;
    case "donHardHat":
      return 1;
  }
  return 0;
}

class SeededGenerator {
  private state: bigint;

  constructor(seed: bigint | number) {
    const normalized = BigInt.asUintN(64, BigInt(seed));
    this.state = normalized === 0n ? NONZERO_SEED : normalized;
  }

  next(): bigint {
    this.state ^= this.state >> 12n;
    this.state = BigInt.asUintN(64, this.state);
    this.state ^= this.state << 25n;
    this.state = BigInt.asUintN(64, this.state);
    this.state ^= this.state >> 27n;
    this.state = BigInt.asUintN(64, this.state);
    return (this.state * XORSHIFT_MULTIPLIER) & MASK_64;
  }

  unit(): number {
    return Number(this.next() >> 11n) / 9_007_199_254_740_992;
  }
}

/** Mood loops plus randomized blink, gaze, claw-snap, and mood-beat schedules. */
export class MascotAnimator {
  private readonly rng: SeededGenerator;
  private currentMood: MascotMood = "idle";
  private startTime: number | null = null;
  private lastPoseTime = 0;
  private activeGesture: Gesture | null = null;
  private activeGestureStart = 0;
  private pendingGesture: Gesture | null = null;
  private pendingGestureAt = 0;
  private nextBlinkAt = 0;
  private pendingDoubleBlink = false;
  private blinkStarts: number[] = [];
  private nextGlanceAt = 0;
  private gazeHoldUntil = 0;
  private gazeTarget = { x: 0, y: 0 };
  private currentGaze = { x: 0, y: 0 };
  private nextClawSnapAt = 0;
  private nextMoodBeatAt = 0;
  private teaseActive = false;
  private teaseChangedAt = 0;
  private catchStartedAt: number | null = null;

  constructor(seed: bigint | number = BigInt(Date.now())) {
    this.rng = new SeededGenerator(seed);
  }

  setMood(mood: MascotMood, time: number): void {
    if (mood === this.currentMood) {
      return;
    }
    this.currentMood = mood;
    // A queued hello-wave or a mid-flight gesture from the previous mood would
    // otherwise keep animating into the new mood's body language.
    this.pendingGesture = null;
    this.activeGesture = null;
    this.rescheduleMoodBeat(time);
    const entrance = this.entranceGesture(mood);
    if (entrance) {
      this.startGesture(entrance, time);
    }
  }

  setTease(active: boolean, time: number): void {
    this.teaseActive = active;
    this.teaseChangedAt = time;
  }

  playCatch(time: number): void {
    this.catchStartedAt = time;
  }

  poseAt(time: number): MascotPose {
    if (this.startTime === null) {
      this.begin(time);
    }
    const dt = clamp(time - this.lastPoseTime, 0, 0.1);
    this.lastPoseTime = time;
    this.advanceSchedules(time);

    const pose = this.basePose(this.currentMood, time);
    this.applyGaze(pose, this.currentMood, time, dt);
    this.applyBlinks(pose, time);

    if (this.activeGesture) {
      const progress = (time - this.activeGestureStart) / gestureDuration(this.activeGesture);
      if (progress >= 1) {
        this.activeGesture = null;
      } else {
        this.applyGesture(this.activeGesture, pose, progress);
      }
    }

    if (this.teaseActive && time >= this.teaseChangedAt) {
      pose.mouthRound = Math.max(pose.mouthRound, 0.5);
      pose.gaze = { x: 0, y: 0.6 };
    }
    if (this.catchStartedAt !== null) {
      const progress = (time - this.catchStartedAt) / CATCH_DURATION;
      if (progress >= 1) {
        this.catchStartedAt = null;
      } else if (progress >= 0) {
        const flash = bell(progress);
        this.applyGesture("clawSnap", pose, clamp(progress / 0.75));
        pose.happyEyes = Math.max(pose.happyEyes, 0.9 * flash);
        pose.mouthCurve = Math.max(pose.mouthCurve, 0.7 * flash);
        pose.blush = Math.max(pose.blush, 0.65 * flash);
      }
    }

    return clampMascotPose(pose);
  }

  private begin(time: number): void {
    this.startTime = time;
    this.lastPoseTime = time;
    this.nextBlinkAt = time + this.random(0.8, 2.4);
    this.nextGlanceAt = time + this.random(1.5, 4);
    this.nextClawSnapAt = time + this.random(2, 5);
    this.rescheduleMoodBeat(time);
    if (
      this.currentMood === "idle" ||
      this.currentMood === "curious" ||
      this.currentMood === "happy"
    ) {
      this.pendingGesture = "wave";
      this.pendingGestureAt = time + 0.9;
    }
  }

  private advanceSchedules(time: number): void {
    if (time >= this.nextBlinkAt) {
      this.blinkStarts.push(time);
      if (this.pendingDoubleBlink) {
        this.pendingDoubleBlink = false;
        this.nextBlinkAt = time + this.blinkInterval();
      } else if (this.random(0, 1) < 0.14) {
        this.pendingDoubleBlink = true;
        this.nextBlinkAt = time + 0.34;
      } else {
        this.nextBlinkAt = time + this.blinkInterval();
      }
    }
    this.blinkStarts = this.blinkStarts.filter((start) => time - start <= BLINK_DURATION);

    if (time >= this.nextGlanceAt) {
      this.gazeTarget = this.randomGlanceTarget();
      this.gazeHoldUntil = time + this.random(0.7, 1.9);
      this.nextGlanceAt = this.gazeHoldUntil + this.glanceInterval();
    } else if (time >= this.gazeHoldUntil) {
      this.gazeTarget = { x: 0, y: 0 };
    }

    if (time >= this.nextClawSnapAt) {
      if (
        this.activeGesture === null &&
        this.currentMood !== "sad" &&
        this.currentMood !== "working"
      ) {
        this.startGesture("clawSnap", time);
      }
      this.nextClawSnapAt = time + this.random(4, 9);
    }

    if (time >= this.nextMoodBeatAt) {
      if (this.activeGesture === null) {
        if (this.currentMood === "sad") {
          this.startGesture("sigh", time);
        } else if (this.currentMood === "sleepy") {
          this.startGesture("yawn", time);
        } else if (this.currentMood === "working") {
          this.startGesture("wipeBrow", time);
        }
      }
      this.rescheduleMoodBeat(time);
    }

    if (this.pendingGesture && time >= this.pendingGestureAt && this.activeGesture === null) {
      const pending = this.pendingGesture;
      this.pendingGesture = null;
      this.startGesture(pending, time);
    }
  }

  private basePose(mood: MascotMood, time: number): MascotPose {
    const pose = createMascotPose();
    switch (mood) {
      case "idle":
        pose.floatOffset = -4.8 * (1 - Math.cos(TAU * cyclePhase(time, 4)));
        pose.antennaDegrees = -3 * Math.sin(TAU * cyclePhase(time, 2));
        break;
      case "curious":
        pose.floatOffset = -4.2 * (1 - Math.cos(TAU * cyclePhase(time, 3.4)));
        pose.antennaDegrees = -4 * Math.sin(TAU * cyclePhase(time, 1.7));
        pose.bodyTilt = 1.6 * Math.sin(TAU * cyclePhase(time, 5.2));
        break;
      case "thinking":
        pose.floatOffset = -3.2 * (1 - Math.cos(TAU * cyclePhase(time, 5)));
        pose.antennaDegrees = -5 * Math.sin(TAU * cyclePhase(time, 1.3));
        pose.bodyTilt = 2 * Math.sin(TAU * cyclePhase(time, 6));
        pose.eyeGlowOpacity = 0.9 + 0.1 * Math.sin(TAU * cyclePhase(time, 0.8));
        break;
      case "working": {
        const phase = cyclePhase(time, 0.95);
        if (phase < 0.05) {
          pose.rightClawDegrees = -6;
        } else if (phase < 0.6) {
          pose.rightClawDegrees = -6 - 28 * easeInOut((phase - 0.05) / 0.55);
        } else if (phase < 0.72) {
          const strike = clamp((phase - 0.6) / 0.12);
          pose.rightClawDegrees = -34 + 46 * strike * strike;
        } else {
          pose.rightClawDegrees = 12 - 18 * easeInOut((phase - 0.72) / 0.28);
        }
        pose.leftClawDegrees = 4 + 2 * Math.sin(TAU * phase);
        const impact = bell(clamp((phase - 0.72) / 0.14));
        pose.floatOffset = -2 * (1 - Math.cos(TAU * cyclePhase(time, 3.8))) + 0.8 * impact;
        pose.bodyStretch = 1 - 0.03 * impact;
        pose.bodyTilt = 2.2 + 0.6 * Math.sin(TAU * cyclePhase(time, 5));
        if (phase >= 0.72) {
          const recoil = clamp((phase - 0.72) / 0.28);
          pose.antennaDegrees = 6 * (1 - recoil) * Math.sin(recoil * 3 * Math.PI);
        }
        pose.leftEyeOpenness = 0.85;
        pose.rightEyeOpenness = 0.85;
        pose.mouthCurve = 0.18;
        pose.hardHat = 1;
        pose.effect = "sparks";
        const strikePhase = (phase - 0.72) % 1;
        pose.effectPhase = strikePhase < 0 ? strikePhase + 1 : strikePhase;
        break;
      }
      case "happy":
        pose.floatOffset = -6 * (1 - Math.cos(TAU * cyclePhase(time, 3)));
        pose.antennaDegrees = -4.5 * Math.sin(TAU * cyclePhase(time, 1.6));
        pose.mouthCurve = 0.55 + 0.1 * Math.sin(TAU * cyclePhase(time, 3));
        pose.happyEyes = 0.35;
        break;
      case "celebrating": {
        const hop = Math.abs(Math.sin(TAU * cyclePhase(time, 1.6)));
        pose.floatOffset = -9 * hop;
        pose.bodyStretch = 1 + 0.03 * hop;
        pose.antennaDegrees = -6 * Math.sin(TAU * cyclePhase(time, 0.8));
        const clawWave = Math.sin(TAU * cyclePhase(time, 0.9));
        pose.leftClawDegrees = 20 + 8 * clawWave;
        pose.rightClawDegrees = -20 + 8 * clawWave;
        pose.mouthCurve = 0.9;
        pose.mouthOpen = 0.35;
        pose.happyEyes = 0.7;
        pose.glowScale = 1.1;
        pose.effect = "sparkles";
        pose.effectPhase = cyclePhase(time, 2.2);
        break;
      }
      case "sad":
        pose.floatOffset = -2.4 * (1 - Math.cos(TAU * cyclePhase(time, 5.5)));
        pose.antennaDegrees = -1.5 * Math.sin(TAU * cyclePhase(time, 3));
        pose.antennaDroop = 0.75;
        pose.mouthCurve = -0.55;
        pose.eyeGlowOpacity = 0.6;
        break;
      case "sleepy":
        pose.floatOffset = -2 * (1 - Math.cos(TAU * cyclePhase(time, 6)));
        pose.antennaDroop = 0.35;
        pose.leftEyeOpenness = 0.22 + 0.08 * Math.sin(TAU * cyclePhase(time, 3));
        pose.rightEyeOpenness = pose.leftEyeOpenness;
        pose.eyeGlowOpacity = 0.5;
        pose.mouthRound = 0.15;
        pose.bodyTilt = 2.5 * Math.sin(TAU * cyclePhase(time, 6));
        pose.effect = "zzz";
        pose.effectPhase = cyclePhase(time, 3);
        break;
      case "attentive":
        pose.floatOffset = -3 * (1 - Math.cos(TAU * cyclePhase(time, 4)));
        pose.antennaDegrees = -2.5 * Math.sin(TAU * cyclePhase(time, 2));
        pose.mouthCurve = 0.25;
        break;
    }
    return pose;
  }

  private applyGaze(pose: MascotPose, mood: MascotMood, time: number, dt: number): void {
    let target = this.gazeTarget;
    switch (mood) {
      case "thinking":
        target = { x: 0.4 * Math.sin(TAU * cyclePhase(time, 3.8)), y: -0.55 };
        break;
      case "working":
        target = {
          x: 0.55 + 0.04 * Math.sin(TAU * cyclePhase(time, 4.6)),
          y: 0.45 + 0.02 * Math.cos(TAU * cyclePhase(time, 3.9)),
        };
        break;
      case "attentive":
        target = { x: target.x * 0.5, y: 0.35 };
        break;
      case "sad":
        target = { x: target.x * 0.3, y: 0.5 };
        break;
      case "sleepy":
        target = { x: 0, y: 0.4 };
        break;
      case "idle":
      case "curious":
      case "happy":
      case "celebrating":
        break;
    }
    const blend = 1 - Math.exp(-dt * 9);
    this.currentGaze.x += (target.x - this.currentGaze.x) * blend;
    this.currentGaze.y += (target.y - this.currentGaze.y) * blend;
    pose.gaze = { ...this.currentGaze };
  }

  private applyBlinks(pose: MascotPose, time: number): void {
    if (pose.happyEyes >= 0.6) {
      return;
    }
    for (const start of this.blinkStarts) {
      const progress = (time - start) / BLINK_DURATION;
      if (progress < 0 || progress > 1) {
        continue;
      }
      const closure = bell(progress);
      pose.leftEyeOpenness = Math.min(pose.leftEyeOpenness, 1 - closure);
      pose.rightEyeOpenness = Math.min(pose.rightEyeOpenness, 1 - closure);
      pose.eyeGlowOpacity *= Math.max(0.3, 1 - closure);
    }
  }

  private applyGesture(gesture: Gesture, pose: MascotPose, progress: number): void {
    const p = clamp(progress);
    switch (gesture) {
      case "wave": {
        const raised = plateau(p, 0.18, 0.82);
        pose.rightClawDegrees += raised * (-28 + 9 * Math.sin(p * 6 * Math.PI));
        pose.bodyTilt += -2 * raised;
        pose.mouthCurve = Math.max(pose.mouthCurve, 0.5 * raised);
        break;
      }
      case "hop": {
        const air = bell(clamp((p - 0.2) / 0.6));
        pose.floatOffset += -9 * air;
        pose.bodyStretch +=
          0.045 * air - 0.1 * bell(clamp(p / 0.2)) - 0.06 * bell(clamp((p - 0.82) / 0.18));
        pose.mouthCurve = Math.max(pose.mouthCurve, 0.4 * air);
        break;
      }
      case "celebrate": {
        const envelope = plateau(p, 0.12, 0.88);
        const hops = Math.abs(Math.sin(p * 4 * Math.PI));
        pose.floatOffset += -11 * hops * envelope;
        pose.bodyStretch += 0.035 * hops * envelope;
        pose.leftClawDegrees += 38 * envelope;
        pose.rightClawDegrees += -38 * envelope;
        pose.happyEyes = Math.max(pose.happyEyes, envelope);
        pose.mouthCurve = Math.max(pose.mouthCurve, envelope);
        pose.mouthOpen = Math.max(pose.mouthOpen, 0.6 * bell(p));
        pose.antennaDroop = 0;
        pose.glowScale = Math.max(pose.glowScale, 1 + 0.2 * envelope);
        pose.effect = "sparkles";
        pose.effectPhase = p;
        break;
      }
      case "sigh": {
        const rise = easeInOut(clamp(p / 0.3));
        const fall = easeInOut(clamp((p - 0.3) / 0.45));
        pose.bodyStretch += 0.025 * rise - 0.08 * fall * (1 - clamp((p - 0.85) / 0.15));
        pose.gaze = { x: pose.gaze.x, y: 0.5 * fall };
        pose.antennaDroop = Math.min(1, pose.antennaDroop + 0.15 * fall);
        break;
      }
      case "yawn": {
        const openness = plateau(p, 0.3, 0.75);
        pose.mouthRound = Math.max(pose.mouthRound, 0.9 * openness);
        pose.leftEyeOpenness = Math.min(pose.leftEyeOpenness, 1 - 0.9 * openness);
        pose.rightEyeOpenness = Math.min(pose.rightEyeOpenness, 1 - 0.9 * openness);
        pose.bodyStretch += 0.03 * openness;
        pose.bodyTilt += -2 * openness;
        break;
      }
      case "clawSnap":
        pose.leftClawDegrees += -8 * bell(clamp(p / 0.7));
        pose.rightClawDegrees += -8 * bell(clamp((p - 0.25) / 0.7));
        break;
      case "donHardHat": {
        const drop = easeInOut(clamp(p / 0.55));
        pose.hardHat = Math.min(pose.hardHat, drop);
        if (p < 0.55) {
          pose.gaze = { x: 0, y: -0.9 * (1 - p) };
        }
        pose.bodyStretch -= 0.04 * bell(clamp((p - 0.5) / 0.2));
        const ready = bell(clamp((p - 0.7) / 0.3));
        pose.leftClawDegrees += -8 * ready;
        pose.rightClawDegrees += 8 * ready;
        break;
      }
      case "wipeBrow": {
        const envelope = plateau(p, 0.2, 0.8);
        pose.leftClawDegrees *= 1 - envelope;
        pose.rightClawDegrees *= 1 - envelope;
        pose.leftClawDegrees += 38 * envelope * (0.9 + 0.1 * Math.sin(p * 5 * Math.PI));
        pose.bodyTilt *= 1 - envelope;
        pose.bodyStretch += 0.02 * envelope;
        pose.happyEyes = Math.max(pose.happyEyes, 0.7 * envelope);
        pose.mouthCurve = Math.max(pose.mouthCurve, 0.5 * envelope);
        pose.gaze = { x: pose.gaze.x * (1 - envelope), y: pose.gaze.y * (1 - envelope) };
        pose.effect = "sweat";
        pose.effectPhase = p;
        break;
      }
    }
  }

  private entranceGesture(mood: MascotMood): Gesture | null {
    switch (mood) {
      case "happy":
        return "hop";
      case "celebrating":
        return "celebrate";
      case "sad":
        return "sigh";
      case "sleepy":
        return "yawn";
      case "working":
        return "donHardHat";
      case "idle":
      case "curious":
      case "thinking":
      case "attentive":
        return null;
    }
    return null;
  }

  private startGesture(gesture: Gesture, time: number): void {
    this.activeGesture = gesture;
    this.activeGestureStart = time;
  }

  private random(min: number, max: number): number {
    return min + (max - min) * this.rng.unit();
  }

  private blinkInterval(): number {
    return this.currentMood === "attentive" ? this.random(1.8, 4) : this.random(2.2, 5.5);
  }

  private glanceInterval(): number {
    if (this.currentMood === "curious") {
      return this.random(1.6, 4);
    }
    if (this.currentMood === "thinking") {
      return this.random(1.2, 3);
    }
    return this.random(3, 8);
  }

  private randomGlanceTarget(): { x: number; y: number } {
    const magnitude = this.random(0.5, 1);
    const angle = this.random(0, TAU);
    return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude * 0.6 };
  }

  private rescheduleMoodBeat(time: number): void {
    this.nextMoodBeatAt = time + this.random(6, 12);
  }
}
