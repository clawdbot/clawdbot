// Control UI test helper supports custom theme setup.
import { parseImportedCustomTheme } from "../app/custom-theme.ts";

const CUSTOM_THEME_MODE_TOKENS = [
  "bg",
  "bg-accent",
  "bg-elevated",
  "bg-hover",
  "bg-muted",
  "bg-content",
  "card",
  "card-foreground",
  "card-highlight",
  "popover",
  "popover-foreground",
  "panel",
  "panel-strong",
  "panel-hover",
  "chrome",
  "chrome-strong",
  "text",
  "text-strong",
  "chat-text",
  "muted",
  "muted-strong",
  "muted-foreground",
  "border",
  "border-strong",
  "border-hover",
  "input",
  "ring",
  "accent",
  "accent-hover",
  "accent-muted",
  "accent-subtle",
  "accent-foreground",
  "accent-glow",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent-2",
  "accent-2-muted",
  "accent-2-subtle",
  "destructive",
  "destructive-foreground",
  "danger",
  "danger-muted",
  "danger-subtle",
  "focus",
  "focus-ring",
  "focus-glow",
  "font-body",
  "font-display",
  "mono",
  "grid-line",
] as const;

export function createTweakcnThemePayload() {
  return {
    name: "Light Green",
    cssVars: {
      theme: {
        "font-sans": "Inter, system-ui, sans-serif",
        "font-mono": "JetBrains Mono, monospace",
      },
      light: {
        background: "oklch(0.98 0.01 120)",
        foreground: "oklch(0.2 0.03 265)",
        card: "oklch(1 0 0)",
        "card-foreground": "oklch(0.2 0.03 265)",
        popover: "oklch(1 0 0)",
        "popover-foreground": "oklch(0.2 0.03 265)",
        primary: "oklch(0.8 0.2 128)",
        "primary-foreground": "oklch(0 0 0)",
        secondary: "oklch(0.35 0.03 257)",
        "secondary-foreground": "oklch(0.98 0.01 248)",
        muted: "oklch(0.96 0.01 248)",
        "muted-foreground": "oklch(0.55 0.04 257)",
        accent: "oklch(0.98 0.02 155)",
        "accent-foreground": "oklch(0.45 0.1 151)",
        destructive: "oklch(0.64 0.2 25)",
        "destructive-foreground": "oklch(1 0 0)",
        border: "oklch(0.92 0.01 255)",
        input: "oklch(0.92 0.01 255)",
        ring: "oklch(0.8 0.2 128)",
      },
      dark: {
        background: "oklch(0.12 0.04 265)",
        foreground: "oklch(0.98 0.01 248)",
        card: "oklch(0.2 0.04 266)",
        "card-foreground": "oklch(0.98 0.01 248)",
        popover: "oklch(0.2 0.04 266)",
        "popover-foreground": "oklch(0.98 0.01 248)",
        primary: "oklch(0.8 0.2 128)",
        "primary-foreground": "oklch(0 0 0)",
        secondary: "oklch(0.28 0.04 260)",
        "secondary-foreground": "oklch(0.98 0.01 248)",
        muted: "oklch(0.28 0.04 260)",
        "muted-foreground": "oklch(0.71 0.03 257)",
        accent: "oklch(0.39 0.09 152)",
        "accent-foreground": "oklch(0.8 0.2 128)",
        destructive: "oklch(0.44 0.16 27)",
        "destructive-foreground": "oklch(1 0 0)",
        border: "oklch(0.28 0.04 260)",
        input: "oklch(0.28 0.04 260)",
        ring: "oklch(0.8 0.2 128)",
      },
    },
  };
}

export function createImportedCustomThemeFixture() {
  const mode = Object.fromEntries(
    CUSTOM_THEME_MODE_TOKENS.map((key) => [
      key,
      key === "font-body" || key === "font-display" || key === "mono"
        ? "Inter, system-ui, sans-serif"
        : "#000000",
    ]),
  );
  const theme = parseImportedCustomTheme({
    sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
    themeId: "cmlhfpjhw000004l4f4ax3m7z",
    label: "Light Green",
    importedAt: new Date().toISOString(),
    light: mode,
    dark: mode,
  });
  if (!theme) {
    throw new Error("Expected custom theme fixture to parse");
  }
  return theme;
}
