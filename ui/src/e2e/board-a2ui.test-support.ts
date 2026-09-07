import type { Frame, Page } from "playwright";

/** Passive, failure-only evidence; never starts ports or changes input/readiness. */
export async function installA2uiFailureDiagnostics(page: Page) {
  const frames = new WeakMap<Frame, number>();
  const lifecycle: { event: string; frame: number; parent?: number }[] = [];
  const errors: string[] = [];
  let nextFrameId = 0;
  let clickFrame: Frame | undefined;
  const frameId = (frame: Frame): number => {
    let id = frames.get(frame);
    if (id === undefined) {
      id = ++nextFrameId;
      frames.set(frame, id);
    }
    return id;
  };
  const recordLifecycle = (event: string, frame: Frame) => {
    if (lifecycle.length < 32) {
      const parent = frame.parentFrame();
      lifecycle.push({
        event,
        frame: frameId(frame),
        parent: parent ? frameId(parent) : undefined,
      });
    }
  };
  page.on("frameattached", (frame) => recordLifecycle("frameattached", frame));
  page.on("framenavigated", (frame) => recordLifecycle("framenavigated", frame));
  page.on("framedetached", (frame) => recordLifecycle("framedetached", frame));
  page.on("console", (message) => {
    if (message.type() === "error" && errors.length < 8) {
      errors.push(message.text().slice(0, 512));
    }
  });
  await page.addInitScript(() => {
    const input: { type: string; trusted: boolean; path: string[] }[] = [];
    const bridge: string[] = [];
    let observedPorts = 0;
    const recordBridge = (value: string) => {
      if (bridge.length < 24) {
        bridge.push(value);
      }
    };
    for (const type of ["pointerdown", "pointerup", "click"]) {
      window.addEventListener(
        type,
        (event) => {
          if (input.length < 12) {
            input.push({
              type,
              trusted: event.isTrusted,
              path: event
                .composedPath()
                .filter((entry): entry is Element => entry instanceof Element)
                .slice(0, 8)
                .map((entry) => entry.tagName.slice(0, 64)),
            });
          }
        },
        { capture: true, passive: true },
      );
    }
    window.addEventListener("message", (event) => {
      const kind = event.data?.type ?? event.data?.method;
      if (
        kind === "openclaw:widget-bridge-ready" ||
        kind === "ui/notifications/sandbox-proxy-ready" ||
        kind === "ui/notifications/sandbox-resource-loaded"
      ) {
        recordBridge(kind);
      }
      if (
        window !== window.top ||
        kind !== "openclaw:widget-bridge-port-offer" ||
        observedPorts >= 8
      ) {
        return;
      }
      observedPorts += 1;
      recordBridge(kind);
      // Observe the host's incoming traffic without starting the port, adopting
      // its ticket, wrapping frozen APIs, or recording authority/payload bytes.
      event.ports[0]?.addEventListener("message", (message) => {
        if (message.data?.type === "openclaw:widget-host-init-ack") {
          recordBridge("host-init-ack");
        } else if (message.data?.type === "openclaw:widget-bridge-request") {
          recordBridge(
            message.data.method === "state.emit" ? "request:state.emit" : "request:other",
          );
        }
      });
    });
    Reflect.set(window, "__a2uiFailureSnapshot", () => {
      const host = document.querySelector("openclaw-a2ui-host");
      const rendererError = host ? Reflect.get(host, "error") : undefined;
      const api = Reflect.get(window, "openclaw");
      const outer = document.querySelector(".board-widget__frame");
      return {
        input,
        bridge,
        readyState: document.readyState,
        rendererDefined: Boolean(customElements.get("openclaw-a2ui-host")),
        rendererConnected: host?.isConnected ?? false,
        rendererError: typeof rendererError === "string" ? rendererError.slice(0, 512) : undefined,
        rendererAlert: host?.shadowRoot
          ?.querySelector('[role="alert"]')
          ?.textContent?.slice(0, 512),
        stateEmitAvailable: typeof api?.state?.emit === "function",
        hostInitialized: typeof api?.host?.controlUiBaseUrl === "string",
        outer: outer
          ? { inert: outer.hasAttribute("inert"), opacity: getComputedStyle(outer).opacity }
          : undefined,
      };
    });
  });
  return {
    target(frame: Frame) {
      clickFrame = frame;
      frameId(frame);
    },
    async snapshot() {
      // Diagnostic collection has its own budget, not a longer action assertion.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const snapshots = await Promise.race([
          Promise.all(
            page
              .frames()
              .slice(0, 8)
              .map(async (frame) => ({
                frame: frameId(frame),
                snapshot: await frame
                  .evaluate(() => {
                    const read = Reflect.get(window, "__a2uiFailureSnapshot");
                    return typeof read === "function" ? read() : { observerMissing: true };
                  })
                  .catch(() => ({ frameUnavailable: true })),
              })),
          ),
          new Promise<"diagnostic collection timed out">((resolve) => {
            timer = setTimeout(() => resolve("diagnostic collection timed out"), 2_000);
          }),
        ]);
        return {
          clickFrame: clickFrame ? frameId(clickFrame) : undefined,
          clickFrameDetached: clickFrame?.isDetached(),
          lifecycle,
          errors,
          snapshots,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
