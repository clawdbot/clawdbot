// A classic script is required here: opaque sandbox frames cannot import
// same-origin ES modules without relaxing the Gateway's asset CORS policy.
(() => {
  const mermaid = globalThis.mermaid;
  const properties = [
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "stroke-dashoffset",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "text-decoration",
    "letter-spacing",
    "word-spacing",
    "visibility",
    "display",
  ];
  // Both application scripts are already loaded. Diagram input can now cause
  // no script, image, stylesheet, font, fetch, or nested-frame network requests.
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  document.head.append(policy);
  mermaid.initialize({ startOnLoad: false });

  const initialize = (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== "openclaw:mermaid-init" ||
      !event.ports[0]
    ) {
      return;
    }
    window.removeEventListener("message", initialize);
    const port = event.ports[0];
    let busy = false;
    const render = async ({ data: { id, source, config, maxSvgLength, maxSvgElements } }) => {
      if (busy) {
        return;
      }
      busy = true;
      const container = document.createElement("div");
      document.body.replaceChildren(container);
      try {
        // Lock every supported configuration root, including future defaults.
        // The source may describe diagrams, but cannot change host policy.
        config.secure = [
          ...new Set([
            ...Object.keys(mermaid.mermaidAPI.defaultConfig),
            ...Object.keys(config),
            ...config.secure,
          ]),
        ];
        mermaid.initialize(config);
        const { svg } = await mermaid.render(`mermaid-${id}`, source, container);
        if (svg.length > maxSvgLength) {
          throw new Error("Mermaid diagram output is too large.");
        }
        container.innerHTML = svg;
        const root = container.querySelector("svg");
        if (!root) {
          throw new Error("Mermaid returned an invalid diagram.");
        }
        const elements = [root, ...root.querySelectorAll("*")];
        if (elements.length > maxSvgElements) {
          throw new Error("Mermaid diagram contains too many elements.");
        }
        // Freeze browser-computed presentation before removing CSS. The parent
        // can then discard all CSS without parsing untrusted style expressions.
        const styles = elements.map((element) => {
          const computed = getComputedStyle(element);
          return properties.map((property) => [property, computed.getPropertyValue(property)]);
        });
        elements.forEach((element, index) => {
          for (const [property, value] of styles[index]) {
            if (value) {
              element.setAttribute(property, value);
            }
          }
          element.removeAttribute("style");
        });
        root.querySelectorAll("style").forEach((style) => style.remove());
        const result = new XMLSerializer().serializeToString(root);
        if (result.length > maxSvgLength) {
          throw new Error("Mermaid diagram output is too large.");
        }
        port.postMessage({ id, svg: result });
      } catch (error) {
        port.postMessage({
          id,
          error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
        });
      } finally {
        document.body.replaceChildren();
        busy = false;
      }
    };
    port.addEventListener("message", (message) => void render(message));
    port.start();
    port.postMessage({ type: "ready" });
  };
  window.addEventListener("message", initialize);
})();
