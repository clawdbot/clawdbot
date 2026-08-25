/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installWidgetThemeObserver, postWidgetTheme } from "../../../lib/widget-theme.ts";

function stubComputedStyles(values: Record<string, string>) {
  vi.stubGlobal(
    "getComputedStyle",
    vi.fn(
      () =>
        ({
          getPropertyValue: (name: string) => values[name] ?? "",
        }) as CSSStyleDeclaration,
    ),
  );
}

function postedMessage(postMessage: ReturnType<typeof vi.fn>) {
  return postMessage.mock.calls[0] as [unknown, string];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeMode;
});

describe("widget theme bridge", () => {
  it("posts host variables mapped to widget tokens, dropping empty values", () => {
    document.documentElement.dataset.themeMode = "light";
    stubComputedStyles({
      "--bg": "  #faf9f7  ",
      "--card": "#ffffff",
      "--text": "   ",
      "--accent": "#bd4531",
      "--primary": "#bd4531",
      "--primary-foreground": "#fff",
      "--radius-full": "9999px",
      "--scrollbar-size": "12px",
      "--scrollbar-thumb-inset": "3px",
      "--scrollbar-thumb": "rgba(110, 105, 96, 0.32)",
      "--scrollbar-thumb-hover": "rgba(110, 105, 96, 0.64)",
      "--mono": " ui-monospace ",
    });
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;

    postWidgetTheme(frame);

    const [message, origin] = postedMessage(postMessage);
    expect(origin).toBe("*");
    expect(message).toEqual({
      type: "openclaw:widget-theme",
      mode: "light",
      tokens: {
        surface: "#faf9f7",
        card: "#ffffff",
        accent: "#bd4531",
        "accent-fill": "#bd4531",
        "accent-fg": "#fff",
        "radius-full": "9999px",
        "scrollbar-size": "12px",
        "scrollbar-thumb-inset": "3px",
        "scrollbar-thumb": "rgba(110, 105, 96, 0.32)",
        "scrollbar-thumb-hover": "rgba(110, 105, 96, 0.64)",
        "font-mono": "ui-monospace",
      },
    });
  });

  it("reports dark mode when the host theme mode is not light", () => {
    document.documentElement.dataset.themeMode = "dark";
    stubComputedStyles({ "--bg": "#0e1015" });
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;

    postWidgetTheme(frame);

    const [message] = postedMessage(postMessage);
    expect(message).toEqual({
      type: "openclaw:widget-theme",
      mode: "dark",
      tokens: { surface: "#0e1015" },
    });
  });

  it("targets the exact origin for authenticated cross-origin embeds", () => {
    document.documentElement.dataset.themeMode = "dark";
    stubComputedStyles({ "--bg": "#0e1015", "--accent": "#ff5c5c" });
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;

    postWidgetTheme(frame, "https://discussion.example");

    expect(postedMessage(postMessage)).toEqual([
      {
        type: "openclaw:widget-theme",
        mode: "dark",
        tokens: { surface: "#0e1015", accent: "#ff5c5c" },
      },
      "https://discussion.example",
    ]);
  });

  it("posts theme changes to connected frames and installs once", () => {
    class FakeMutationObserver {
      static instances: FakeMutationObserver[] = [];
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();
      readonly takeRecords = vi.fn((): MutationRecord[] => []);

      constructor(readonly callback: MutationCallback) {
        FakeMutationObserver.instances.push(this);
      }

      trigger(record: MutationRecord): void {
        this.callback([record], this as unknown as MutationObserver);
      }
    }

    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    vi.stubGlobal("window", {});
    stubComputedStyles({ "--accent": "#c41e30" });
    const chatFrame = document.createElement("iframe");
    chatFrame.className = "chat-tool-card__preview-frame";
    const boardFrame = document.createElement("iframe");
    boardFrame.className = "board-widget__frame";
    const unrelatedFrame = document.createElement("iframe");
    document.body.append(chatFrame, boardFrame, unrelatedFrame);
    const chatPost = vi.spyOn(chatFrame.contentWindow!, "postMessage");
    const boardPost = vi.spyOn(boardFrame.contentWindow!, "postMessage");
    const unrelatedPost = vi.spyOn(unrelatedFrame.contentWindow!, "postMessage");

    installWidgetThemeObserver();
    installWidgetThemeObserver();

    expect(FakeMutationObserver.instances).toHaveLength(1);
    expect(FakeMutationObserver.instances[0]?.observe).toHaveBeenCalledWith(
      document.documentElement,
      {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-mode", "data-color-vision", "style"],
      },
    );
    FakeMutationObserver.instances[0]?.trigger({
      attributeName: "data-theme",
    } as MutationRecord);
    expect(chatPost).toHaveBeenCalledOnce();
    expect(boardPost).toHaveBeenCalledOnce();
    expect(unrelatedPost).not.toHaveBeenCalled();
    FakeMutationObserver.instances[0]?.trigger({
      attributeName: "data-color-vision",
    } as MutationRecord);
    expect(chatPost).toHaveBeenCalledTimes(2);
    expect(boardPost).toHaveBeenCalledTimes(2);
    // Accent overrides land as inline style mutations on <html>.
    FakeMutationObserver.instances[0]?.trigger({
      attributeName: "style",
    } as MutationRecord);
    expect(chatPost).toHaveBeenCalledTimes(3);
    expect(boardPost).toHaveBeenCalledTimes(3);
    expect(unrelatedPost).not.toHaveBeenCalled();
  });
});
