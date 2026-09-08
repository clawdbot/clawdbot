// Hyperlink markdown helpers render markdown links with TUI hyperlink styling.
import type {
  Component,
  DefaultTextStyle,
  MarkdownOptions,
  MarkdownTheme,
} from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";
import { isolateRtlRenderedLine, sanitizeMarkdownSource } from "../tui-formatters.js";

function sanitizeMarkdownDisplayText(text: string): string {
  if (!text) {
    return text;
  }
  return sanitizeMarkdownSource(text) || "(no output)";
}

/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export class HyperlinkMarkdown implements Component {
  private inner: Markdown;
  private urls: string[];
  private cachedRender?: { width: number; lines: string[] };

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
    options?: MarkdownOptions,
  ) {
    const displayText = sanitizeMarkdownDisplayText(text);
    this.inner = new Markdown(displayText, paddingX, paddingY, theme, defaultTextStyle, options);
    this.urls = extractUrls(displayText);
  }

  render(width: number): string[] {
    if (this.cachedRender?.width === width) {
      return this.cachedRender.lines;
    }
    const lines = addOsc8Hyperlinks(this.inner.render(width), this.urls).map(
      isolateRtlRenderedLine,
    );
    this.cachedRender = { width, lines };
    return lines;
  }

  setText(text: string): void {
    const displayText = sanitizeMarkdownDisplayText(text);
    this.inner.setText(displayText);
    this.urls = extractUrls(displayText);
    this.cachedRender = undefined;
  }

  invalidate(): void {
    this.inner.invalidate();
    this.cachedRender = undefined;
  }
}
