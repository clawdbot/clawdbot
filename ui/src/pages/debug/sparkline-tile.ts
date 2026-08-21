import { html, nothing, svg } from "lit";
import { property, state as litState } from "lit/decorators.js";
import { formatDurationCompact } from "../../lib/format.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

export type SparklineSample = { value: number; at: number };

// Chart geometry in viewBox units; the svg stretches (preserveAspectRatio="none"),
// so hover/now markers are positioned with percentages in HTML instead.
const CHART_WIDTH = 100;
const CHART_HEIGHT = 40;
const CHART_TOP_PAD = 4;

// Gradient defs need document-unique ids: the overlay renders one tile per vital
// into the light DOM, so a shared static id would collide across instances.
let gradientCounter = 0;

function nextGradientId(): string {
  gradientCounter += 1;
  return `debug-vital-gradient-${gradientCounter}`;
}

/** Stat tile with an embedded area sparkline and pointer scrubbing. */
class DebugSparklineTile extends OpenClawLightDomElement {
  @property() label = "";
  @property() sub = "";
  @property({ attribute: false }) samples: readonly SparklineSample[] = [];
  @property({ attribute: false }) format: (value: number) => string = String;
  /** Lower bound for the y-axis top, so quiet metrics keep a calm scale. */
  @property({ attribute: false }) floorMax = 0;
  /** Auto-range the baseline near the series minimum instead of zero, so
   * large-but-steady metrics (RSS) still show their trend shape. */
  @property({ type: Boolean }) autorange = false;

  @litState() private hoverIndex: number | null = null;

  private readonly gradientId = nextGradientId();

  private get yRange(): { min: number; span: number } {
    let max = this.floorMax;
    let min = Number.POSITIVE_INFINITY;
    for (const sample of this.samples) {
      if (sample.value > max) {
        max = sample.value;
      }
      if (sample.value < min) {
        min = sample.value;
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
    }
    if (!this.autorange) {
      return { min: 0, span: max > 0 ? max : 1 };
    }
    // Sit the baseline a bit below the observed minimum so the shape stays a
    // trend line, not a wall, while never faking a drop to zero.
    const spread = Math.max(max - min, max * 0.02, 1e-9);
    const base = Math.max(min - spread * 0.5, 0);
    return { min: base, span: Math.max(max - base, 1e-9) };
  }

  private toY(value: number): number {
    const { min, span } = this.yRange;
    const usable = CHART_HEIGHT - CHART_TOP_PAD;
    const ratio = Math.min(Math.max((value - min) / span, 0), 1);
    return CHART_HEIGHT - ratio * usable;
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.samples.length < 2) {
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const ratio = event.offsetX / Math.max(target.clientWidth, 1);
    const index = Math.round(ratio * (this.samples.length - 1));
    this.hoverIndex = Math.min(Math.max(index, 0), this.samples.length - 1);
  };

  private readonly handlePointerLeave = (): void => {
    this.hoverIndex = null;
  };

  private renderChart() {
    const samples = this.samples;
    if (samples.length < 2) {
      return nothing;
    }
    const step = CHART_WIDTH / (samples.length - 1);
    const points = samples
      .map((sample, index) => `${index * step},${this.toY(sample.value)}`)
      .join(" ");
    const last = samples.at(-1);
    if (!last) {
      return nothing;
    }
    const lastY = this.toY(last.value);
    const hover = this.hoverIndex !== null ? samples[this.hoverIndex] : undefined;
    const hoverLeft = this.hoverIndex !== null ? (this.hoverIndex / (samples.length - 1)) * 100 : 0;
    return html`
      <div
        class="debug-vital__chart"
        @pointermove=${this.handlePointerMove}
        @pointerleave=${this.handlePointerLeave}
      >
        <svg
          viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          ${svg`
            <defs>
              <linearGradient id=${this.gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="currentColor" stop-opacity="0.28"></stop>
                <stop offset="1" stop-color="currentColor" stop-opacity="0.02"></stop>
              </linearGradient>
            </defs>
            <polygon
              points="0,${CHART_HEIGHT} ${points} ${CHART_WIDTH},${CHART_HEIGHT}"
              fill="url(#${this.gradientId})"
            ></polygon>
            <polyline points=${points}></polyline>
          `}
        </svg>
        ${hover
          ? html`
              <div class="debug-vital__hairline" style="left: ${hoverLeft}%"></div>
              <div
                class="debug-vital__dot debug-vital__dot--hover"
                style="left: ${hoverLeft}%; top: ${(this.toY(hover.value) / CHART_HEIGHT) * 100}%"
              ></div>
            `
          : html`
              <div
                class="debug-vital__dot debug-vital__dot--now"
                style="left: calc(100% - 3px); top: ${(lastY / CHART_HEIGHT) * 100}%"
              ></div>
            `}
      </div>
    `;
  }

  override render() {
    const samples = this.samples;
    const current = samples.at(-1);
    const hover = this.hoverIndex !== null ? samples[this.hoverIndex] : null;
    const shown = hover ?? current;
    const age =
      hover && current && current.at > hover.at
        ? formatDurationCompact(current.at - hover.at)
        : null;
    return html`
      <div class="debug-vital__head">
        <span class="debug-vital__label">${this.label}</span>
        ${this.sub ? html`<span class="debug-vital__sub mono">${this.sub}</span>` : nothing}
      </div>
      <div class="debug-vital__value mono">
        ${shown ? this.format(shown.value) : "–"}
        ${age ? html`<span class="debug-vital__age">−${age}</span>` : nothing}
      </div>
      ${this.renderChart()}
    `;
  }
}

if (!customElements.get("openclaw-debug-sparkline")) {
  customElements.define("openclaw-debug-sparkline", DebugSparklineTile);
}
