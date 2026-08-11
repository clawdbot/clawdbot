import { svg, type TemplateResult } from "lit";

export function FLATPACK_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <g class="lob-flatpack">
      <path
        d="M48 10 C28 10 17 25 17 41 C17 58 29 69 48 69 C67 69 79 58 79 41 C79 25 68 10 48 10 Z"
        fill="var(--lob-shell)"
        stroke="#8a7c5f"
        stroke-width="2"
        stroke-dasharray="4 3"
      />
      <g class="lob-eye-open" style=${openEyeStyle}>
        <circle cx="39" cy="34" r="4.5" fill="#0a1014" />
        <circle cx="57" cy="34" r="4.5" fill="#0a1014" />
        <circle cx="40.2" cy="32.8" r="1.7" fill="var(--lob-glint, #00e5cc)" />
        <circle cx="58.2" cy="32.8" r="1.7" fill="var(--lob-glint, #00e5cc)" />
      </g>
      <g
        class="lob-eye-closed"
        stroke="#0a1014"
        stroke-width="2.5"
        stroke-linecap="round"
        fill="none"
        style=${closedEyeStyle}
      >
        <path d="M34 35 Q39 31 44 35" />
        <path d="M52 35 Q57 31 62 35" />
      </g>

      <g fill="none" stroke="#8a7c5f" stroke-width="1.5" stroke-dasharray="4 3">
        <path d="M27 48 Q50 58 75 61" />
        <path d="M68 47 Q79 58 92 70" />
      </g>
      <g class="lob-claw lob-claw--l">
        <path
          d="M76 53 C66 50 62 58 67 65 C72 72 82 68 85 60 C87 55 82 53 76 53 Z"
          fill="var(--lob-claw)"
          stroke="#8a7c5f"
          stroke-width="1.5"
          stroke-dasharray="4 3"
        />
      </g>
      <g class="lob-claw lob-claw--r">
        <path
          d="M98 65 C109 62 115 70 111 79 C107 88 96 84 91 76 C88 70 92 66 98 65 Z"
          fill="var(--lob-claw)"
          stroke="#8a7c5f"
          stroke-width="1.5"
          stroke-dasharray="4 3"
        />
      </g>

      <g fill="var(--lob-shell)" stroke="#8a7c5f" stroke-width="1.5" stroke-dasharray="4 3">
        <rect x="15" y="88" width="15" height="6" rx="2" />
        <rect x="34" y="88" width="15" height="6" rx="2" />
        <rect x="53" y="88" width="15" height="6" rx="2" />
        <rect x="72" y="88" width="15" height="6" rx="2" />
      </g>

      <g fill="none" stroke="#5f5648" stroke-width="3" stroke-linecap="round">
        <path d="M84 24 L101 8" />
        <path d="M93 31 L113 14" />
      </g>
      <g fill="#8a7c5f">
        <circle cx="105" cy="29" r="3" />
        <circle cx="113" cy="35" r="3" />
      </g>
      <path
        class="lob-flatpack__allen-key"
        d="M101 84 L101 99 L115 99"
        fill="none"
        stroke="#5f5648"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
  `;
}

export function LOADING_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <!-- Skeleton placeholders stay neutral instead of inheriting palette colors. -->
    <g class="lob-skeleton">
      <rect class="lob-skeleton__block" style="--i:0" x="24" y="18" width="72" height="64" rx="10" fill="#2f3542" />
      <rect class="lob-skeleton__block" style="--i:1" x="2" y="43" width="24" height="20" rx="8" fill="#39404f" />
      <rect class="lob-skeleton__block" style="--i:2" x="94" y="43" width="24" height="20" rx="8" fill="#39404f" />
      <path class="lob-skeleton__block" style="--i:3" d="M45 21 L34 7" stroke="#39404f" stroke-width="6" stroke-linecap="round" />
      <path class="lob-skeleton__block" style="--i:4" d="M75 21 L86 7" stroke="#39404f" stroke-width="6" stroke-linecap="round" />
      <rect class="lob-skeleton__block" style="--i:5" x="31" y="79" width="10" height="22" rx="4" fill="#2f3542" />
      <rect class="lob-skeleton__block" style="--i:6" x="46" y="79" width="10" height="24" rx="4" fill="#39404f" />
      <rect class="lob-skeleton__block" style="--i:7" x="64" y="79" width="10" height="24" rx="4" fill="#39404f" />
      <rect class="lob-skeleton__block" style="--i:8" x="79" y="79" width="10" height="22" rx="4" fill="#2f3542" />
      <g class="lob-eye-open" style=${openEyeStyle}>
        <circle cx="47" cy="43" r="5" fill="#4a5364" />
        <circle cx="73" cy="43" r="5" fill="#4a5364" />
      </g>
      <g class="lob-eye-closed" style=${closedEyeStyle} fill="#4a5364">
        <rect x="41" y="42" width="12" height="3" rx="1.5" />
        <rect x="67" y="42" width="12" height="3" rx="1.5" />
      </g>
    </g>
  `;
}

export function ACTUAL_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <g class="lob-actual">
      <g fill="none" stroke="#6f281d" stroke-linecap="round">
        <path d="M47 27 Q27 5 2 3" stroke-width="2" />
        <path d="M73 27 Q93 5 118 3" stroke-width="2" />
        <path d="M46 29 Q34 16 22 13" stroke-width="1.3" />
        <path d="M74 29 Q86 16 98 13" stroke-width="1.3" />
      </g>

      <g fill="none" stroke="#7f3022" stroke-width="2.2" stroke-linecap="round">
        <path d="M39 48 Q22 52 10 65" />
        <path d="M38 56 Q20 62 8 77" />
        <path d="M40 65 Q24 72 15 88" />
        <path d="M43 74 Q31 82 27 97" />
        <path d="M81 48 Q98 52 110 65" />
        <path d="M82 56 Q100 62 112 77" />
        <path d="M80 65 Q96 72 105 88" />
        <path d="M77 74 Q89 82 93 97" />
      </g>

      <g class="lob-actual__tail" fill="#8f3220" stroke="#6f281d" stroke-width="1.4">
        <path d="M48 88 Q38 91 31 103 Q44 103 55 96 Z" />
        <path d="M72 88 Q82 91 89 103 Q76 103 65 96 Z" />
        <path d="M54 89 Q60 96 66 89 L69 104 Q60 101 51 104 Z" />
      </g>

      <g class="lob-claw lob-claw--l">
        <path
          d="M34 43 Q25 31 12 33 Q0 35 2 48 Q4 61 17 63 Q28 64 35 54 L30 49 Q22 54 15 50 Q10 47 13 42 Q17 37 24 42 Z"
          fill="var(--lob-claw)"
          stroke="#6f281d"
          stroke-width="1.5"
        />
      </g>
      <g class="lob-claw lob-claw--r">
        <path
          d="M86 44 Q94 32 104 34 Q113 35 116 42 L107 45 L118 49 Q115 58 105 60 Q96 61 87 53 Z"
          fill="var(--lob-claw)"
          stroke="#6f281d"
          stroke-width="1.5"
        />
      </g>

      <path
        class="lob-actual__carapace"
        d="M60 20 Q38 20 34 38 Q32 50 41 58 Q49 64 60 64 Q71 64 79 58 Q88 50 86 38 Q82 20 60 20 Z"
        fill="var(--lob-shell)"
        stroke="#6f281d"
        stroke-width="1.8"
      />
      <g class="lob-actual__abdomen" stroke="#6f281d" stroke-width="1.4">
        <path d="M39 54 Q60 62 81 54 L79 65 Q60 72 41 65 Z" fill="#b34b35" />
        <path d="M41 65 Q60 72 79 65 L76 76 Q60 82 44 76 Z" fill="#a63c28" />
        <path d="M44 76 Q60 82 76 76 L72 87 Q60 92 48 87 Z" fill="#b34b35" />
        <path d="M48 87 Q60 92 72 87 L67 96 Q60 99 53 96 Z" fill="#a63c28" />
      </g>
      <path d="M48 42 Q60 48 72 42 Q69 56 60 58 Q51 56 48 42 Z" fill="#bd6044" opacity="0.72" />

      <g fill="none" stroke="#6f281d" stroke-width="2.2" stroke-linecap="round">
        <path d="M47 28 L45 23" />
        <path d="M73 28 L75 23" />
      </g>
      <g class="lob-eye-open" style=${openEyeStyle}>
        <circle cx="45" cy="22" r="3.5" fill="#17100e" />
        <circle cx="75" cy="22" r="3.5" fill="#17100e" />
        <circle cx="46" cy="21" r="1" fill="#f2c6a8" />
        <circle cx="76" cy="21" r="1" fill="#f2c6a8" />
      </g>
      <g class="lob-eye-closed" style=${closedEyeStyle} fill="none" stroke="#17100e" stroke-width="2" stroke-linecap="round">
        <path d="M41.5 22 H48.5" />
        <path d="M71.5 22 H78.5" />
      </g>
    </g>
  `;
}

export function BALLOON_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <g class="lob-balloon">
      <g fill="none" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round">
        <path d="M48 13 Q45 5 42 3" />
        <path d="M72 13 Q75 5 78 3" />
      </g>

      <g class="lob-claw lob-claw--l" fill="var(--lob-claw)">
        <ellipse cx="29" cy="29" rx="9" ry="7" transform="rotate(-20 29 29)" />
        <ellipse cx="20" cy="35" rx="8" ry="6" transform="rotate(18 20 35)" />
      </g>
      <g class="lob-claw lob-claw--r" fill="var(--lob-claw)">
        <ellipse cx="91" cy="29" rx="9" ry="7" transform="rotate(20 91 29)" />
        <ellipse cx="100" cy="35" rx="8" ry="6" transform="rotate(-18 100 35)" />
      </g>

      <ellipse cx="60" cy="29" rx="24" ry="19" fill="var(--lob-shell)" />
      <circle cx="60" cy="48" r="4" fill="#d94b72" />
      <ellipse cx="60" cy="61" rx="18" ry="14" fill="var(--lob-shell)" />
      <circle cx="60" cy="75" r="3.5" fill="#d94b72" />
      <ellipse cx="60" cy="86" rx="13" ry="10" fill="var(--lob-shell)" />

      <g fill="#ffffff" opacity="0.55">
        <ellipse cx="50" cy="22" rx="4" ry="10" transform="rotate(35 50 22)" />
        <ellipse cx="52" cy="56" rx="3" ry="7" transform="rotate(32 52 56)" />
        <ellipse cx="54" cy="82" rx="2.4" ry="5" transform="rotate(28 54 82)" />
      </g>

      <g class="lob-eye-open" style=${openEyeStyle}>
        <circle cx="50" cy="30" r="4.5" fill="#0a1014" />
        <circle cx="70" cy="30" r="4.5" fill="#0a1014" />
        <circle cx="51.3" cy="28.7" r="1.8" fill="var(--lob-glint, #00e5cc)" />
        <circle cx="71.3" cy="28.7" r="1.8" fill="var(--lob-glint, #00e5cc)" />
      </g>
      <g
        class="lob-eye-closed"
        style=${closedEyeStyle}
        fill="none"
        stroke="#0a1014"
        stroke-width="2.5"
        stroke-linecap="round"
      >
        <path d="M45 31 Q50 27 55 31" />
        <path d="M65 31 Q70 27 75 31" />
      </g>

      <path d="M55 96 L60 91 L65 96 L60 101 Z" fill="#d94b72" />
      <path
        d="M60 100 Q67 102 62 105 Q57 108 65 111"
        fill="none"
        stroke="#c9d2da"
        stroke-width="1.2"
        stroke-linecap="round"
      />
    </g>
  `;
}

export function ASCII_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <!-- Like pet names and lore, terminal glyph art is an English-only easter-egg channel. -->
    <g
      class="lob-ascii"
      fill="var(--lob-shell)"
      font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
      font-size="11"
      text-anchor="middle"
      xml:space="preserve"
    >
      <text x="60" y="17">\\ /         \\ /</text>
      <text x="60" y="31">{  \\_______/  }</text>
      <g class="lob-eye-open" style=${openEyeStyle}>
        <text x="60" y="45">(o)     (o)</text>
      </g>
      <g class="lob-eye-closed" style=${closedEyeStyle}>
        <text x="60" y="45">(-)     (-)</text>
      </g>
      <text x="60" y="59">(    '---'    )</text>
      <text x="60" y="73"> \\   _____   /</text>
      <text x="60" y="87">  (_________)</text>
      <text x="60" y="101">    | | | |</text>
    </g>
  `;
}

export function PORTAL_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <g class="lob-portal">
      <ellipse
        class="lob-portal-ring lob-portal-ring--blue"
        cx="30"
        cy="50"
        rx="14"
        ry="30"
        fill="#0d1b33"
        fill-opacity="0.85"
        stroke="currentColor"
        stroke-width="3"
        transform="rotate(-12 30 50)"
      />

      <!-- Fixed lobster red preserves the split-body gag while shell/claw vars carry portal identity. -->
      <path d="M31 30 Q45 20 56 30 Q62 39 60 53 Q58 64 47 70 L31 67 Z" fill="#b0432f" />
      <g class="lob-claw lob-claw--l">
        <path
          d="M52 54 Q58 48 63 51 Q67 56 63 62 Q58 67 52 63 Z"
          fill="#b0432f"
        />
      </g>
      <g fill="none" stroke="#b0432f" stroke-width="2" stroke-linecap="round">
        <path d="M42 31 Q43 16 50 7" />
        <path d="M52 28 Q58 14 66 9" />
      </g>
      <g class="lob-eye-open" style=${openEyeStyle}>
        <circle cx="45" cy="39" r="4" fill="#0a1014" />
        <circle cx="57" cy="37" r="4" fill="#0a1014" />
        <circle cx="46" cy="38" r="1.5" fill="var(--lob-glint, #00e5cc)" />
        <circle cx="58" cy="36" r="1.5" fill="var(--lob-glint, #00e5cc)" />
      </g>
      <g
        class="lob-eye-closed"
        style=${closedEyeStyle}
        fill="none"
        stroke="#0a1014"
        stroke-width="2.2"
        stroke-linecap="round"
      >
        <path d="M41 40 Q45 37 49 40" />
        <path d="M53 38 Q57 35 61 38" />
      </g>

      <g class="lob-portal-rear" fill="#b0432f">
        <path d="M91 44 Q82 40 75 44 L82 51 L74 56 L82 61 L75 68 Q83 70 92 64 Z" />
        <path d="M88 52 Q82 49 78 45" fill="none" stroke="#7f3022" stroke-width="2" />
        <path d="M88 61 Q82 64 78 69" fill="none" stroke="#7f3022" stroke-width="2" />
      </g>
      <ellipse
        class="lob-portal-ring lob-portal-ring--orange"
        cx="92"
        cy="58"
        rx="14"
        ry="30"
        fill="#0d1b33"
        fill-opacity="0.85"
        stroke="currentColor"
        stroke-width="3"
        transform="rotate(10 92 58)"
      />
    </g>
  `;
}

export const WATERMELON_RIND = svg`
  <g class="lob-watermelon">
    <g fill="none" stroke="#2c7a4a" stroke-width="4" stroke-linecap="round">
      <path d="M31 25 Q39 13 48 11" />
      <path d="M48 22 Q54 10 60 9" />
      <path d="M66 22 Q72 10 80 15" />
      <path d="M82 28 Q89 20 94 30" />
    </g>
    <ellipse cx="60" cy="69" rx="35" ry="23" fill="#e5484d" />
    <g fill="#28211c">
      <ellipse cx="42" cy="62" rx="2" ry="3.4" transform="rotate(-20 42 62)" />
      <ellipse cx="58" cy="58" rx="2" ry="3.4" transform="rotate(8 58 58)" />
      <ellipse cx="76" cy="64" rx="2" ry="3.4" transform="rotate(24 76 64)" />
      <ellipse cx="49" cy="77" rx="2" ry="3.4" transform="rotate(18 49 77)" />
      <ellipse cx="68" cy="79" rx="2" ry="3.4" transform="rotate(-16 68 79)" />
      <ellipse cx="84" cy="75" rx="1.8" ry="3.1" transform="rotate(30 84 75)" />
    </g>
  </g>
`;

export function TINFOIL_PARTS(showHat: boolean): TemplateResult {
  return svg`
    <g class="lob-tinfoil" fill="none" stroke="#c9d2da" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M27 31 L38 27 L45 34 L55 25 L64 33 L75 26 L91 34" />
      <path d="M20 51 L31 45 L43 54 L55 45 L68 54 L82 44 L100 53" />
      <path d="M23 70 L36 64 L47 73 L60 63 L74 72 L90 65 L98 72" />
      <path d="M35 86 L46 80 L58 87 L70 79 L84 85" />
    </g>
    ${
      showHat
        ? svg`
          <g class="lob-tinfoil-hat">
            <path d="M43 14 L57 0 L78 15 L60 11 Z" fill="#c0c9d1" />
            <path d="M57 0 L60 11 L78 15" fill="none" stroke="#7f8992" stroke-width="1.5" />
            <path d="M43 14 L60 11 L53 5" fill="none" stroke="#9aa4ad" stroke-width="1.5" />
          </g>
        `
        : ""
    }
  `;
}

export const ECLIPSE_CORONA = svg`
  <path
    class="lob-eclipse-corona"
    d="M29 31 Q40 10 61 9 Q82 9 94 31"
    fill="none"
    stroke="#ffe9b8"
    stroke-width="2.5"
    stroke-linecap="round"
  />
`;

const CHECKER_ROWS = [
  { y: 12, x: 44, count: 4 },
  { y: 20, x: 36, count: 6 },
  { y: 28, x: 28, count: 8 },
  { y: 36, x: 20, count: 10 },
  { y: 44, x: 16, count: 11 },
  { y: 52, x: 16, count: 11 },
  { y: 60, x: 16, count: 11 },
  { y: 68, x: 20, count: 10 },
  { y: 76, x: 24, count: 9 },
  { y: 84, x: 32, count: 7 },
  { y: 92, x: 44, count: 4 },
] as const;

export const NOTEXTURE_CHECKER = svg`
  <g class="lob-notexture" shape-rendering="crispEdges">
    ${CHECKER_ROWS.flatMap((row, rowIndex) =>
      Array.from(
        { length: row.count },
        (_, column) =>
          svg`<rect
          x=${row.x + column * 8}
          y=${row.y}
          width="8"
          height="8"
          fill=${(rowIndex + column) % 2 === 0 ? "#ff00dc" : "#111111"}
        />`,
      ),
    )}
  </g>
`;

export const CHIMERA_STITCHES = svg`
  <g class="lob-chimera-stitches" fill="none" stroke="#4a3f3a" stroke-width="1.8" stroke-linecap="round">
    <path d="M18 47 L27 50 M19 51 L22 46 M23 53 L26 48" />
    <path d="M93 50 L102 47 M94 48 L97 53 M98 46 L101 51" />
  </g>
`;
