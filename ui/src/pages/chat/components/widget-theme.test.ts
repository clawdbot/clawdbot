/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installWidgetThemeObserver, postWidgetTheme } from "./widget-theme.ts";

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
    stubComputedStyles({ "--accent": "#c41e30" });
    const connectedPost = vi.fn();
    const detachedPost = vi.fn();
    const connected = {
      isConnected: true,
      contentWindow: { postMessage: connectedPost },
    } as unknown as HTMLIFrameElement;
    const detached = {
      isConnected: false,
      contentWindow: { postMessage: detachedPost },
    } as unknown as HTMLIFrameElement;
    const getFrames = () => [connected, detached];

    installWidgetThemeObserver(getFrames);
    installWidgetThemeObserver(getFrames);

    expect(FakeMutationObserver.instances).toHaveLength(1);
    expect(FakeMutationObserver.instances[0]?.observe).toHaveBeenCalledWith(
      document.documentElement,
      {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-mode"],
      },
    );
    FakeMutationObserver.instances[0]?.trigger({
      attributeName: "data-theme",
    } as MutationRecord);
    expect(connectedPost).toHaveBeenCalledOnce();
    expect(detachedPost).not.toHaveBeenCalled();
  });
});
