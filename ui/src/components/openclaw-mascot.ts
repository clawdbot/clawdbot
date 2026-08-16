import { css, html, LitElement, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { MascotAnimator } from "./mascot-animator.ts";
import { drawMascot } from "./mascot-canvas.ts";
import {
  mascotPalette,
  staticMascotPose,
  type MascotMood,
  type MascotPose,
} from "./mascot-pose.ts";

const DEFAULT_SIZE = 120;
const MASCOT_MOODS = new Set<MascotMood>([
  "idle",
  "curious",
  "thinking",
  "working",
  "happy",
  "celebrating",
  "sad",
  "sleepy",
  "attentive",
]);

function currentSeconds(): number {
  return performance.now() / 1_000;
}

class OpenClawMascot extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      width: var(--openclaw-mascot-size, 120px);
      height: var(--openclaw-mascot-size, 120px);
      overflow: visible;
      contain: layout style;
      pointer-events: none;
      line-height: 0;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
      will-change: transform;
    }
  `;

  @property({ reflect: true }) mood: MascotMood = "idle";
  @property({ type: Number }) size = DEFAULT_SIZE;
  @property({ type: Boolean }) tease = false;

  private readonly animator = new MascotAnimator();
  private animationFrame = 0;
  private visible = true;
  private reducedMotion = false;
  private lastPose: MascotPose = staticMascotPose("idle");
  private intersectionObserver: IntersectionObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private motionQuery: MediaQueryList | null = null;

  private readonly handleVisibilityChange = () => this.syncPlayback();

  private readonly handleMotionChange = (event: MediaQueryListEvent) => {
    this.reducedMotion = event.matches;
    this.syncPlayback();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("aria-hidden", "true");
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    this.motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.reducedMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener("change", this.handleMotionChange);

    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        this.visible = entries.some((entry) => entry.isIntersecting);
        this.syncPlayback();
      });
      this.intersectionObserver.observe(this);
    }

    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() => this.drawPose(this.lastPose));
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme-mode"],
      });
    }
  }

  override disconnectedCallback(): void {
    this.stopAnimation();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.motionQuery?.removeEventListener("change", this.handleMotionChange);
    this.motionQuery = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    // Seed the animator's mood before the first pose so `begin()` schedules
    // for the real mood; `updated()` runs after this and would be too late.
    this.animator.setMood(this.resolvedMood, currentSeconds());
    this.animator.setTease(this.tease, currentSeconds());
    this.drawCurrentFrame(currentSeconds());
    this.syncPlayback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("size")) {
      this.style.setProperty("--openclaw-mascot-size", `${this.resolvedSize}px`);
    }
    if (changed.has("mood")) {
      this.animator.setMood(this.resolvedMood, currentSeconds());
    }
    if (changed.has("tease")) {
      this.animator.setTease(this.tease, currentSeconds());
    }
    if (changed.has("size") || changed.has("mood") || changed.has("tease")) {
      this.drawCurrentFrame(currentSeconds());
      this.syncPlayback();
    }
  }

  catchOnce(): void {
    if (!this.isConnected || this.reducedMotion) {
      return;
    }
    const time = currentSeconds();
    this.animator.playCatch(time);
    this.drawCurrentFrame(time);
    this.syncPlayback();
  }

  override render() {
    return html`<canvas></canvas>`;
  }

  private get resolvedMood(): MascotMood {
    return MASCOT_MOODS.has(this.mood) ? this.mood : "idle";
  }

  private get resolvedSize(): number {
    return Number.isFinite(this.size) && this.size > 0 ? this.size : DEFAULT_SIZE;
  }

  private get shouldAnimate(): boolean {
    return (
      this.isConnected &&
      this.visible &&
      !this.reducedMotion &&
      document.visibilityState !== "hidden"
    );
  }

  private readonly renderAnimationFrame = (timestamp: number) => {
    this.animationFrame = 0;
    if (!this.shouldAnimate) {
      return;
    }
    this.drawCurrentFrame(timestamp / 1_000);
    this.animationFrame = window.requestAnimationFrame(this.renderAnimationFrame);
  };

  private syncPlayback(): void {
    if (!this.renderRoot.querySelector("canvas")) {
      return;
    }
    if (this.reducedMotion) {
      this.stopAnimation();
      this.lastPose = staticMascotPose(this.resolvedMood);
      this.drawPose(this.lastPose);
      return;
    }
    if (!this.shouldAnimate) {
      this.stopAnimation();
      return;
    }
    if (this.animationFrame === 0) {
      this.animationFrame = window.requestAnimationFrame(this.renderAnimationFrame);
    }
  }

  private stopAnimation(): void {
    if (this.animationFrame !== 0) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  private drawCurrentFrame(time: number): void {
    this.lastPose = this.reducedMotion
      ? staticMascotPose(this.resolvedMood)
      : this.animator.poseAt(time);
    this.drawPose(this.lastPose);
  }

  private drawPose(pose: MascotPose): void {
    const canvas = this.renderRoot.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || typeof Path2D === "undefined") {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const size = this.resolvedSize;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const pixelSize = Math.round(size * pixelRatio);
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, size, size);
    drawMascot(
      pose,
      mascotPalette(document.documentElement.dataset.themeMode === "light"),
      context,
      size,
    );
    canvas.style.transform = `translate3d(0, ${(pose.floatOffset * size) / 120}px, 0)`;
  }
}

if (!customElements.get("openclaw-mascot")) {
  customElements.define("openclaw-mascot", OpenClawMascot);
}
