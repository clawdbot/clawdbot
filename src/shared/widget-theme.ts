export const WIDGET_THEME_TOKENS = [
  "surface",
  "card",
  "elevated",
  "text",
  "text-strong",
  "muted",
  "border",
  "border-strong",
  "accent",
  "accent-fill",
  "accent-fg",
  "ok",
  "warn",
  "danger",
  "info",
  "radius",
  "radius-full",
  "scrollbar-size",
  "scrollbar-thumb-inset",
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  "font-body",
  "font-mono",
] as const;

export type WidgetThemeToken = (typeof WIDGET_THEME_TOKENS)[number];

export const WIDGET_THEME_MESSAGE_TYPE = "openclaw:widget-theme";

export type WidgetThemeMessage = {
  type: typeof WIDGET_THEME_MESSAGE_TYPE;
  mode: "light" | "dark";
  tokens: Record<string, string>;
};
