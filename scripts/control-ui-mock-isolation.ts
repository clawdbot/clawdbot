import type { Plugin } from "vite";

/** Runs before preview and app modules; the preview owns Gateway selection. */
function installStandaloneNetworkBoundary(): void {
  const nativeFetch = window.fetch.bind(window);
  const localOrigin = window.location.origin;
  const isLocalResource = (url: URL) =>
    url.origin === localOrigin || url.protocol === "data:" || url.protocol === "blob:";
  const blocked = (capability: string) =>
    new DOMException(
      `Standalone mock blocked ${capability}. Add a local fixture or use pnpm ui:dev for a real Gateway.`,
      "NotSupportedError",
    );

  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!isLocalResource(url)) {
      throw blocked(`fetch to ${url.origin}`);
    }
    // A local resource must not redirect an authenticated request off the fixture server.
    return nativeFetch(request, { redirect: "error" });
  };

  // Full Chromium preconnects iframe destinations before checking frame-src.
  // Reject URL writes before navigation starts; CSP still guards frame contents.
  const checkFrameUrl = (value: string) => {
    const url = new URL(value, window.location.href);
    if (!isLocalResource(url) && url.href !== "about:blank") {
      throw blocked(`iframe to ${url.origin}`);
    }
  };
  const framePrototype = HTMLIFrameElement.prototype;
  const frameSrc = Object.getOwnPropertyDescriptor(framePrototype, "src");
  if (!frameSrc?.set) {
    throw blocked("unsupported iframe implementation");
  }
  Object.defineProperty(framePrototype, "src", {
    ...frameSrc,
    set(value: string) {
      checkFrameUrl(value);
      frameSrc.set!.call(this, value);
    },
  });
  framePrototype.setAttribute = function (name, value) {
    if (name.toLowerCase() === "src") {
      checkFrameUrl(value);
    }
    Element.prototype.setAttribute.call(this, name, value);
  };
  framePrototype.setAttributeNS = function (namespace, name, value) {
    if (!namespace && name.toLowerCase() === "src") {
      checkFrameUrl(value);
    }
    Element.prototype.setAttributeNS.call(this, namespace, name, value);
  };

  // CSP covers resource loads, not native RTC or top-level navigation. Keep
  // these side effects out of standalone demos, including deferred blank popups.
  for (const capability of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
    function blockedTransport(): never {
      throw blocked(capability);
    }
    Object.defineProperty(window, capability, { value: blockedTransport });
  }
  window.open = () => {
    console.warn(blocked("popup").message);
    return null;
  };
  window.navigation?.addEventListener("navigate", (event) => {
    if (new URL(event.destination.url).origin !== localOrigin) {
      event.preventDefault();
      console.warn(blocked("external navigation").message);
    }
  });
  for (const eventName of ["click", "auxclick"]) {
    window.addEventListener(
      eventName,
      (event) => {
        const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
        const url = anchor ? new URL(anchor.href) : null;
        const localDownload =
          anchor?.download && (url?.protocol === "blob:" || url?.protocol === "data:");
        if (url && url.origin !== localOrigin && !localDownload) {
          event.preventDefault();
          console.warn(blocked("external link").message);
        }
      },
      true,
    );
  }
}

export function createStandaloneMockIsolationPlugins(): Plugin[] {
  // tsx can emit __name calls in serialized functions; keep that helper local
  // to the injected script, just like the shared Gateway mock initializer.
  const script = `(() => { const __name = (target) => target; (${installStandaloneNetworkBoundary.toString()})(); })();`;
  return [
    {
      name: "openclaw-control-ui-mock-isolation",
      enforce: "pre",
      configureServer(server) {
        // Install before *all* custom fixture handlers, not only Vite's HTML
        // handler: frame/attachment documents need the same native boundary.
        server.middlewares.use((req, res, next) => {
          const origin = new URL(`http://${req.headers.host}`).origin;
          res.setHeader(
            "Content-Security-Policy",
            [
              "default-src 'self'",
              `connect-src 'self' ${origin.replace(/^http:/, "ws:")} blob: data:`,
              // The bundled terminal compiles local Wasm; JavaScript eval stays disabled.
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data:",
              "media-src 'self' blob: data:",
              "font-src 'self' data:",
              "frame-src 'self' blob: data:",
              "worker-src 'none'",
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'none'",
              "sandbox allow-scripts allow-same-origin allow-downloads",
            ].join("; "),
          );
          res.setHeader("X-DNS-Prefetch-Control", "off");
          next();
        });
      },
      transformIndexHtml: {
        order: "pre",
        handler: () => [{ tag: "script", children: script, injectTo: "head-prepend" }],
      },
    },
    {
      name: "openclaw-control-ui-mock-http-misses",
      enforce: "post",
      configureServer(server) {
        // Registered after fixture handlers but before Vite's SPA fallback.
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? "/", "http://mock.invalid").pathname;
          if (!/^\/(?:api|avatar|__openclaw__|__fixtures)\//.test(pathname)) {
            next();
            return;
          }
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Standalone mock has no HTTP fixture for this route." }));
        });
      },
    },
  ];
}
