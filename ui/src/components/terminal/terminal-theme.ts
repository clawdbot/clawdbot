// Maps the Control UI light/dark surfaces onto the terminal's 16-color theme.
import type {
  CreateGhosttyTerminalOptions,
  TerminalDefaultColors,
} from "@openclaw/libterminal/browser";

type TerminalTheme = NonNullable<
  NonNullable<CreateGhosttyTerminalOptions["terminalOptions"]>["theme"]
>;

// ANSI palettes tuned per mode: colors that read on the near-black surface sit
// at 1.4-2.6:1 on the light surface, so light gets its own darkened set
// (>=4.5:1 on #f7f8fa) instead of sharing the dark palette.
const DARK_ANSI = {
  black: "#1b1e26",
  red: "#ff6b6b",
  green: "#4ec9a8",
  yellow: "#e5c07b",
  blue: "#5aa2ff",
  magenta: "#c586c0",
  cyan: "#56b6c2",
  white: "#d7dae0",
  brightBlack: "#5c6370",
  brightRed: "#ff8787",
  brightGreen: "#6fd7bd",
  brightYellow: "#f0d197",
  brightBlue: "#7cb7ff",
  brightMagenta: "#d7a3d4",
  brightCyan: "#7bd3dd",
  brightWhite: "#ffffff",
} as const;

// Same hue identities as DARK_ANSI, darkened for the light surface. Bright
// variants go darker than normal ones so bold/bright text stays emphatic
// instead of washing out; brightWhite maps to the strongest ink, matching
// the light-theme convention in Ghostty/iTerm paired themes.
const LIGHT_ANSI = {
  black: "#3a3f4b",
  red: "#c62f3d",
  green: "#177a5e",
  yellow: "#8f6400",
  blue: "#1e66d0",
  magenta: "#94439c",
  cyan: "#0f7487",
  white: "#1b1e26",
  brightBlack: "#5c6370",
  brightRed: "#a3242f",
  brightGreen: "#0f664e",
  brightYellow: "#755200",
  brightBlue: "#1a55ab",
  brightMagenta: "#7c3382",
  brightCyan: "#0c6070",
  brightWhite: "#0a0c10",
} as const;

function resolveTerminalColor(styles: CSSStyleDeclaration, property: string): string {
  const value = styles.getPropertyValue(property).trim();
  if (!value || /^#[\da-f]{6}$/iu.test(value)) {
    return value.toLowerCase();
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) {
    return value;
  }
  // Custom themes may use modern color functions, while OSC 10-12 accepts
  // only concrete #rrggbb colors; reading a painted pixel resolves both.
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function terminalDynamicColors(): TerminalDefaultColors {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: resolveTerminalColor(styles, "--bg"),
    cursor: resolveTerminalColor(styles, "--accent"),
    foreground: resolveTerminalColor(styles, "--text"),
  };
}

/** Builds the terminal theme for the given Control UI color mode. */
export function terminalTheme(mode: "dark" | "light"): TerminalTheme {
  const colors = terminalDynamicColors();
  return {
    ...(mode === "light" ? LIGHT_ANSI : DARK_ANSI),
    ...colors,
    cursorAccent: colors.background,
    selectionBackground: `${colors.cursor}${mode === "light" ? "4d" : "52"}`,
  };
}
