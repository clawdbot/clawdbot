import {
  WIDGET_THEME_MESSAGE_TYPE,
  WIDGET_THEME_TOKENS,
  type WidgetThemeMessage,
  type WidgetThemeToken,
} from "../../../src/shared/widget-theme.ts";

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
  "radius-full": "--radius-full",
  "scrollbar-size": "--scrollbar-size",
  "scrollbar-thumb-inset": "--scrollbar-thumb-inset",
  "scrollbar-thumb": "--scrollbar-thumb",
  "scrollbar-thumb-hover": "--scrollbar-thumb-hover",
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

export function buildWidgetThemeMessage(): WidgetThemeMessage {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return {
    type: WIDGET_THEME_MESSAGE_TYPE,
    mode: root.dataset.themeMode === "light" ? "light" : "dark",
    tokens: collectWidgetThemeTokens((hostVar) => styles.getPropertyValue(hostVar)),
  };
}

export function postWidgetTheme(frame: HTMLIFrameElement, targetOrigin = "*"): void {
  frame.contentWindow?.postMessage(buildWidgetThemeMessage(), targetOrigin);
}

const widgetThemeObserverWindows = new WeakSet<Window>();
const widgetThemeFrames = new WeakMap<Window, Map<HTMLIFrameElement, string>>();

/** Explicit registration also reaches widgets inside a chat component's shadow root. */
export function registerWidgetThemeFrame(frame: HTMLIFrameElement, origin: string): () => void {
  let frames = widgetThemeFrames.get(window);
  if (!frames) {
    frames = new Map();
    widgetThemeFrames.set(window, frames);
  }
  frames.set(frame, origin);
  installWidgetThemeObserver();
  return () => frames.delete(frame);
}

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
    const registered = widgetThemeFrames.get(window);
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(
      ".chat-tool-card__preview-frame, .board-widget__frame",
    )) {
      if (!registered?.has(frame)) {
        postWidgetTheme(frame);
      }
    }
    for (const [frame, origin] of registered ?? []) {
      if (frame.isConnected) {
        postWidgetTheme(frame, origin);
      } else {
        registered?.delete(frame);
      }
    }
  }).observe(root, {
    attributes: true,
    // "style" carries the accent override (inline custom properties on <html>);
    // without it a user accent change would only reach frames incidentally.
    attributeFilter: ["data-theme", "data-theme-mode", "style"],
  });
}
