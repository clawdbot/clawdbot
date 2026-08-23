const WIDGET_THEME_TOKENS = [
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
  "font-body",
  "font-mono",
] as const;

type WidgetThemeToken = (typeof WIDGET_THEME_TOKENS)[number];

const HOST_TOKEN_SOURCES: Record<WidgetThemeToken, string> = {
  surface: "--bg",
  card: "--card",
  elevated: "--bg-elevated",
  text: "--text",
  "text-strong": "--text-strong",
  muted: "--muted",
  border: "--border",
  "border-strong": "--border-strong",
  accent: "--accent",
  "accent-fill": "--primary",
  "accent-fg": "--primary-foreground",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
  radius: "--radius",
  "font-body": "--font-body",
  "font-mono": "--mono",
};

function collectWidgetThemeTokens(read: (hostVar: string) => string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const token of WIDGET_THEME_TOKENS) {
    const value = read(HOST_TOKEN_SOURCES[token]).trim();
    if (value) {
      tokens[token] = value;
    }
  }
  return tokens;
}

export function buildWidgetThemeMessage(): {
  type: "openclaw:widget-theme";
  mode: "light" | "dark";
  tokens: Record<string, string>;
} {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return {
    type: "openclaw:widget-theme",
    mode: root.dataset.themeMode === "light" ? "light" : "dark",
    tokens: collectWidgetThemeTokens((hostVar) => styles.getPropertyValue(hostVar)),
  };
}

export function postWidgetTheme(frame: HTMLIFrameElement, targetOrigin = "*"): void {
  frame.contentWindow?.postMessage(buildWidgetThemeMessage(), targetOrigin);
}

const widgetThemeObserverWindows = new WeakSet<Window>();

export function installWidgetThemeObserver(): void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return;
  }
  if (widgetThemeObserverWindows.has(window)) {
    return;
  }
  widgetThemeObserverWindows.add(window);
  const root = document.documentElement;
  new MutationObserver(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(
      ".chat-tool-card__preview-frame, .board-widget__frame",
    )) {
      postWidgetTheme(frame);
    }
  }).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-mode"],
  });
}
