import { vi } from "vitest";
import type { ApplicationContext } from "./context.ts";

export type ShellKeyboardState = {
  runtime: { context: ApplicationContext };
  handleDocumentKeydown: (event: KeyboardEvent) => void;
};

export function resetAppHostTestGlobals(): void {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "webkit");
  document.documentElement.classList.remove(
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
  );
  vi.unstubAllGlobals();
}

export type TestOptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

let lazyElementSequence = 0;

export function createLazyElementSpec(label: string): TestOptionalCustomElement {
  lazyElementSequence += 1;
  const tagName = `openclaw-app-host-lazy-${lazyElementSequence}`;
  return {
    tagName,
    label,
    loadModule: async () => {
      customElements.define(tagName, class extends HTMLElement {});
    },
  };
}
