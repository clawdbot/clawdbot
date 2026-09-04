import { MermaidTransientError, renderMermaidSvg, type MermaidTheme } from "./renderer.ts";

type NativeMermaidJob = {
  id: string;
  source: string;
  widthCssPx: number;
  theme: MermaidTheme;
};

declare global {
  interface Window {
    renderMermaid: (job: NativeMermaidJob) => Promise<void>;
    ChatMermaidBridge?: { postMessage: (message: string) => void };
    webkit?: {
      messageHandlers: { ChatMermaidBridge?: { postMessage: (message: string) => void } };
    };
  }
}

function postResult(result: object) {
  const bridge = window.ChatMermaidBridge ?? window.webkit?.messageHandlers.ChatMermaidBridge;
  // Hosts accept native results only from this top-level local document.
  // Diagram input and Mermaid execute in the opaque child frame.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Native bridges accept one JSON string, not Window.postMessage arguments.
  bridge?.postMessage(JSON.stringify(result));
}

let imageUrl: string | undefined;
async function renderNativeMermaid(job: NativeMermaidJob) {
  let decodeTimeout: number | undefined;
  try {
    const svg = await renderMermaidSvg(job.source, job.theme);
    const root = new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("svg")!;
    const bounds = root.viewBox.baseVal;
    const width = Math.ceil(job.widthCssPx);
    const height = Math.ceil((bounds.height * width) / bounds.width);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1 ||
      width > 8_192 ||
      height > 8_192 ||
      width * height > 4_194_304
    ) {
      throw new Error("Diagram image is too large.");
    }
    const image = new Image();
    const previousUrl = imageUrl;
    imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    image.src = imageUrl;
    image.alt = "";
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }
    await Promise.race([
      image.decode().catch((error: unknown) => {
        throw new MermaidTransientError(error instanceof Error ? error.message : String(error));
      }),
      new Promise<never>((_, reject) => {
        decodeTimeout = window.setTimeout(
          () => reject(new MermaidTransientError("Diagram image timed out.")),
          5_000,
        );
      }),
    ]);
    image.width = width;
    image.height = height;
    document.getElementById("diagram")!.replaceChildren(image);
    postResult({ id: job.id, success: true, svg, widthCssPx: image.width, heightCssPx: height });
  } catch (error) {
    document.getElementById("diagram")!.replaceChildren();
    postResult({
      id: job.id,
      success: false,
      retryable: error instanceof MermaidTransientError,
      error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
    });
  } finally {
    window.clearTimeout(decodeTimeout);
  }
}

// Keep image decoding and native result delivery in the same queue as layout.
// A second request must not replace the first image before its result arrives.
let renderQueue = Promise.resolve();
window.renderMermaid = (job) => {
  const result = renderQueue.then(() => renderNativeMermaid(job));
  renderQueue = result.catch(() => {});
  return result;
};

window.addEventListener("pagehide", () => {
  if (imageUrl) {
    URL.revokeObjectURL(imageUrl);
  }
});
