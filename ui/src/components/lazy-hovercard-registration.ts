import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";

export type HovercardBootstrapTrigger = "focus" | "pointer";

export class LazyHovercardBootstrap<TElement extends HTMLElement, TProperties> {
  private stopListeners: (() => void) | null = null;

  constructor(
    private readonly params: {
      tag: string;
      load: () => Promise<CustomElementConstructor>;
      snapshot: (element: TElement) => TProperties;
      restore: (element: TElement, properties: TProperties) => void;
      onDefined?: () => void;
    },
  ) {}

  install(activate: (event: Event, trigger: HovercardBootstrapTrigger) => Promise<void>): void {
    if (!customElements.get(this.params.tag)) {
      this.stopListeners = installHovercardBootstrapListeners(activate);
    }
  }

  providerFor(target: Element): TElement | null {
    return target.closest<TElement>(this.params.tag);
  }

  async define(): Promise<void> {
    const pending = new Map(
      [...document.querySelectorAll<TElement>(this.params.tag)].map((element) => [
        element,
        this.params.snapshot(element),
      ]),
    );
    await ensureCustomElementDefined(this.params.tag, async () => {
      const provider = await this.params.load();
      // Non-isolated test modules can share one document and element registry.
      if (!customElements.get(this.params.tag)) {
        customElements.define(this.params.tag, provider);
      }
      for (const [element, properties] of pending) {
        this.params.restore(element, properties);
      }
    });
    this.stopListeners?.();
    this.stopListeners = null;
    this.params.onDefined?.();
  }
}

function installHovercardBootstrapListeners(
  activate: (event: Event, trigger: HovercardBootstrapTrigger) => Promise<void>,
): () => void {
  const listeners = {
    focus: (event: Event) => void activate(event, "focus"),
    pointer: (event: Event) => void activate(event, "pointer"),
  };
  document.addEventListener("pointerover", listeners.pointer, true);
  document.addEventListener("focusin", listeners.focus, true);
  return () => {
    document.removeEventListener("pointerover", listeners.pointer, true);
    document.removeEventListener("focusin", listeners.focus, true);
  };
}

export function hovercardBootstrapIntentActive(
  target: HTMLElement,
  trigger: HovercardBootstrapTrigger,
  focusWithin = false,
): boolean {
  if (trigger === "pointer") {
    return target.matches(":hover");
  }
  return focusWithin
    ? document.activeElement instanceof Node && target.contains(document.activeElement)
    : document.activeElement === target;
}

export function remainingHovercardOpenDelay(startedAt: number, openDelayMs: number): number {
  return Math.max(0, openDelayMs - (performance.now() - startedAt));
}
