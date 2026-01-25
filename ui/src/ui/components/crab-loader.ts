import { html, TemplateResult } from "lit";

export type CrabLoaderSize = "sm" | "md" | "lg";

export type CrabLoaderProps = {
  message?: string;
  size?: CrabLoaderSize;
};

/**
 * Renders the Clawdbot crab loader animation.
 *
 * @example
 * ```ts
 * import { renderCrabLoader } from "./components/crab-loader";
 *
 * // Default usage
 * ${renderCrabLoader()}
 *
 * // With custom message
 * ${renderCrabLoader({ message: "Loading sessions" })}
 *
 * // Different sizes: "sm" | "md" | "lg"
 * ${renderCrabLoader({ size: "lg" })}
 * ```
 */
export function renderCrabLoader(props: CrabLoaderProps = {}): TemplateResult {
  const { message = "Getting my claws on it", size = "md" } = props;

  return html`
    <div class="crab-loader crab-loader--${size}">
      <div class="crab-loader__crab">
        ${renderCrabSvg()}
      </div>
      <div class="crab-loader__text">
        <span>${message}</span>
        <span class="crab-loader__dots">
          <span class="crab-loader__dot"></span>
          <span class="crab-loader__dot"></span>
          <span class="crab-loader__dot"></span>
        </span>
      </div>
    </div>
  `;
}

function renderCrabSvg(): TemplateResult {
  return html`
    <svg
      class="crab-loader__svg"
      viewBox="0 0 520 442"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shape-rendering="crispEdges"
    >
      <!-- Left claw -->
      <g class="crab-loader__claw-left">
        <rect x="26" y="156" width="26" height="26" fill="#F41641" />
        <rect y="130" width="26" height="26" fill="#F41641" />
        <rect y="104" width="26" height="26" fill="#F41641" />
        <rect y="78" width="26" height="26" fill="#F41641" />
        <rect y="52" width="26" height="26" fill="#F41641" />
        <rect y="26" width="26" height="26" fill="#F41641" />
        <rect x="26" y="78" width="26" height="26" fill="#F41641" />
        <rect x="52" width="26" height="26" fill="#F41641" />
        <rect x="78" width="26" height="26" fill="#F41641" />
        <rect x="52" y="26" width="26" height="26" fill="#F41641" />
        <rect x="52" y="78" width="26" height="26" fill="#C50026" />
        <rect x="78" y="52" width="26" height="26" fill="#C50026" />
        <rect x="26" y="52" width="26" height="26" fill="#F41641" />
        <rect x="26" y="26" width="26" height="26" fill="#F41641" />
        <rect x="26" width="26" height="26" fill="#F41641" />
      </g>

      <!-- Right claw -->
      <g class="crab-loader__claw-right">
        <rect width="26" height="26" transform="matrix(-1 0 0 1 520 130)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 520 104)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 520 78)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 520 52)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 520 26)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 494 78)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 468 0)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 442 0)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 468 26)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 468 78)" fill="#C50026" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 442 52)" fill="#C50026" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 494 52)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 494 26)" fill="#F41641" />
        <rect width="26" height="26" transform="matrix(-1 0 0 1 494 0)" fill="#F41641" />
      </g>

      <!-- Eyes -->
      <rect x="130" y="182" width="26" height="26" fill="#F41641" />
      <rect x="156" y="182" width="26" height="26" fill="#F41641" />
      <rect x="156" y="156" width="26" height="26" fill="#F41641" />
      <rect x="156" y="130" width="26" height="26" fill="#F41641" />
      <rect x="156" y="78" width="26" height="26" fill="#6A0014" />
      <rect x="130" y="78" width="26" height="26" fill="#FFC1CD" />
      <rect x="130" y="104" width="26" height="26" fill="#FFC1CD" />
      <rect x="156" y="104" width="26" height="26" fill="#FFC1CD" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 182)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 156)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 130)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 78)" fill="#6A0014" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 390 78)" fill="#FFC1CD" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 390 104)" fill="#FFC1CD" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 104)" fill="#FFC1CD" />

      <!-- Body -->
      <rect x="182" y="182" width="26" height="26" fill="#F41641" />
      <rect x="52" y="182" width="26" height="26" fill="#F41641" />
      <rect x="78" y="182" width="26" height="26" fill="#F41641" />
      <rect x="104" y="182" width="26" height="26" fill="#F41641" />
      <rect x="286" y="182" width="26" height="26" fill="#F41641" />
      <rect x="286" y="156" width="26" height="26" fill="#F41641" />
      <rect x="312" y="182" width="26" height="26" fill="#F41641" />
      <rect x="208" y="182" width="26" height="26" fill="#F41641" />
      <rect x="208" y="156" width="26" height="26" fill="#F41641" />
      <rect x="234" y="182" width="26" height="26" fill="#F41641" />
      <rect x="260" y="182" width="26" height="26" fill="#F41641" />
      <rect x="416" y="182" width="26" height="26" fill="#F41641" />
      <rect x="442" y="182" width="26" height="26" fill="#F41641" />
      <rect x="468" y="156" width="26" height="26" fill="#F41641" />
      <rect x="364" y="182" width="26" height="26" fill="#F41641" />
      <rect x="390" y="182" width="26" height="26" fill="#F41641" />

      <!-- Body rows -->
      <rect x="130" y="260" width="26" height="26" fill="#F41641" />
      <rect x="156" y="260" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 260)" fill="#F41641" />
      <rect x="182" y="260" width="26" height="26" fill="#F41641" />
      <rect x="78" y="260" width="26" height="26" fill="#F41641" />
      <rect x="104" y="260" width="26" height="26" fill="#F41641" />
      <rect x="286" y="260" width="26" height="26" fill="#F41641" />
      <rect x="312" y="260" width="26" height="26" fill="#F41641" />
      <rect x="208" y="260" width="26" height="26" fill="#F41641" />
      <rect x="234" y="260" width="26" height="26" fill="#F41641" />
      <rect x="260" y="260" width="26" height="26" fill="#F41641" />
      <rect x="416" y="260" width="26" height="26" fill="#F41641" />
      <rect x="364" y="260" width="26" height="26" fill="#F41641" />
      <rect x="390" y="260" width="26" height="26" fill="#F41641" />
      <rect x="130" y="234" width="26" height="26" fill="#F41641" />
      <rect x="156" y="234" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 234)" fill="#F41641" />
      <rect x="182" y="234" width="26" height="26" fill="#F41641" />
      <rect x="78" y="234" width="26" height="26" fill="#F41641" />
      <rect x="104" y="234" width="26" height="26" fill="#F41641" />
      <rect x="286" y="234" width="26" height="26" fill="#F41641" />
      <rect x="312" y="234" width="26" height="26" fill="#F41641" />
      <rect x="208" y="234" width="26" height="26" fill="#F41641" />
      <rect x="234" y="234" width="26" height="26" fill="#F41641" />
      <rect x="260" y="234" width="26" height="26" fill="#F41641" />
      <rect x="416" y="234" width="26" height="26" fill="#F41641" />
      <rect x="364" y="234" width="26" height="26" fill="#F41641" />
      <rect x="390" y="234" width="26" height="26" fill="#F41641" />
      <rect x="130" y="208" width="26" height="26" fill="#F41641" />
      <rect x="156" y="208" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 208)" fill="#F41641" />
      <rect x="182" y="208" width="26" height="26" fill="#F41641" />
      <rect x="78" y="208" width="26" height="26" fill="#F41641" />
      <rect x="104" y="208" width="26" height="26" fill="#F41641" />
      <rect x="286" y="208" width="26" height="26" fill="#F41641" />
      <rect x="312" y="208" width="26" height="26" fill="#F41641" />
      <rect x="208" y="208" width="26" height="26" fill="#F41641" />
      <rect x="234" y="208" width="26" height="26" fill="#F41641" />
      <rect x="260" y="208" width="26" height="26" fill="#F41641" />
      <rect x="416" y="208" width="26" height="26" fill="#F41641" />
      <rect x="364" y="208" width="26" height="26" fill="#F41641" />
      <rect x="390" y="208" width="26" height="26" fill="#F41641" />

      <!-- Lower body and legs -->
      <rect x="130" y="390" width="26" height="26" fill="#F41641" />
      <rect x="156" y="390" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 390)" fill="#F41641" />
      <rect x="182" y="390" width="26" height="26" fill="#F41641" />
      <rect x="104" y="390" width="26" height="26" fill="#F41641" />
      <rect x="286" y="390" width="26" height="26" fill="#F41641" />
      <rect x="312" y="390" width="26" height="26" fill="#F41641" />
      <rect x="208" y="390" width="26" height="26" fill="#F41641" />
      <rect x="234" y="390" width="26" height="26" fill="#F41641" />
      <rect x="260" y="390" width="26" height="26" fill="#F41641" />
      <rect x="364" y="390" width="26" height="26" fill="#F41641" />
      <rect x="390" y="390" width="26" height="26" fill="#F41641" />
      <rect x="130" y="364" width="26" height="26" fill="#F41641" />
      <rect x="156" y="364" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 364)" fill="#F41641" />
      <rect x="182" y="364" width="26" height="26" fill="#F41641" />
      <rect x="78" y="364" width="26" height="26" fill="#F41641" />
      <rect x="104" y="364" width="26" height="26" fill="#F41641" />
      <rect x="286" y="364" width="26" height="26" fill="#F41641" />
      <rect x="312" y="364" width="26" height="26" fill="#F41641" />
      <rect x="208" y="364" width="26" height="26" fill="#F41641" />
      <rect x="234" y="364" width="26" height="26" fill="#F41641" />
      <rect x="260" y="364" width="26" height="26" fill="#F41641" />
      <rect x="416" y="364" width="26" height="26" fill="#F41641" />
      <rect x="364" y="364" width="26" height="26" fill="#F41641" />
      <rect x="390" y="364" width="26" height="26" fill="#F41641" />
      <rect x="130" y="338" width="26" height="26" fill="#F41641" />
      <rect x="156" y="338" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 338)" fill="#F41641" />
      <rect x="182" y="338" width="26" height="26" fill="#F41641" />
      <rect x="78" y="338" width="26" height="26" fill="#F41641" />
      <rect x="104" y="338" width="26" height="26" fill="#F41641" />
      <rect x="286" y="338" width="26" height="26" fill="#F41641" />
      <rect x="312" y="338" width="26" height="26" fill="#F41641" />
      <rect x="208" y="338" width="26" height="26" fill="#F41641" />
      <rect x="234" y="338" width="26" height="26" fill="#F41641" />
      <rect x="260" y="338" width="26" height="26" fill="#F41641" />
      <rect x="416" y="338" width="26" height="26" fill="#F41641" />
      <rect x="442" y="338" width="26" height="26" fill="#F41641" />
      <rect x="468" y="338" width="26" height="26" fill="#F41641" />
      <rect x="494" y="364" width="26" height="26" fill="#F41641" />
      <rect x="494" y="390" width="26" height="26" fill="#F41641" />
      <rect x="494" y="416" width="26" height="26" fill="#F41641" />
      <rect x="442" y="390" width="26" height="26" fill="#F41641" />
      <rect x="442" y="416" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 78 338)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 52 338)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 26 364)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 26 390)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 26 416)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 78 390)" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 78 416)" fill="#F41641" />
      <rect x="364" y="338" width="26" height="26" fill="#F41641" />
      <rect x="390" y="338" width="26" height="26" fill="#F41641" />
      <rect x="130" y="312" width="26" height="26" fill="#F41641" />
      <rect x="156" y="312" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 312)" fill="#F41641" />
      <rect x="182" y="312" width="26" height="26" fill="#F41641" />
      <rect x="78" y="312" width="26" height="26" fill="#F41641" />
      <rect x="104" y="312" width="26" height="26" fill="#F41641" />
      <rect x="286" y="312" width="26" height="26" fill="#F41641" />
      <rect x="312" y="312" width="26" height="26" fill="#F41641" />
      <rect x="208" y="312" width="26" height="26" fill="#F41641" />
      <rect x="234" y="312" width="26" height="26" fill="#F41641" />
      <rect x="260" y="312" width="26" height="26" fill="#F41641" />
      <rect x="416" y="312" width="26" height="26" fill="#F41641" />
      <rect x="364" y="312" width="26" height="26" fill="#F41641" />
      <rect x="390" y="312" width="26" height="26" fill="#F41641" />
      <rect x="130" y="286" width="26" height="26" fill="#F41641" />
      <rect x="156" y="286" width="26" height="26" fill="#F41641" />
      <rect width="26" height="26" transform="matrix(-1 0 0 1 364 286)" fill="#F41641" />
      <rect x="182" y="286" width="26" height="26" fill="#F41641" />
      <rect x="78" y="286" width="26" height="26" fill="#F41641" />
      <rect x="104" y="286" width="26" height="26" fill="#F41641" />
      <rect x="286" y="286" width="26" height="26" fill="#F41641" />
      <rect x="312" y="286" width="26" height="26" fill="#F41641" />
      <rect x="208" y="286" width="26" height="26" fill="#F41641" />
      <rect x="234" y="286" width="26" height="26" fill="#F41641" />
      <rect x="260" y="286" width="26" height="26" fill="#F41641" />
      <rect x="416" y="286" width="26" height="26" fill="#F41641" />
      <rect x="364" y="286" width="26" height="26" fill="#F41641" />
      <rect x="390" y="286" width="26" height="26" fill="#F41641" />
    </svg>
  `;
}
