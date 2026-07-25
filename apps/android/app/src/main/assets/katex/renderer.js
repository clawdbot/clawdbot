"use strict";

window.renderMath = async (job) => {
  const container = document.getElementById("math");
  try {
    document.body.style.width = `${job.widthCssPx}px`;
    container.style.color = job.color;
    container.style.fontSize = `${job.fontSizeCssPx}px`;
    container.replaceChildren();
    katex.render(job.latex, container, {
      displayMode: true,
      maxExpand: 1000,
      maxSize: 10,
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initialBounds = container.getBoundingClientRect();
    const width = Math.ceil(Math.max(initialBounds.width, container.scrollWidth));
    document.body.style.width = `${width}px`;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalBounds = container.getBoundingClientRect();
    const height = Math.ceil(Math.max(finalBounds.height, container.scrollHeight));
    ChatMathBridge.onRenderComplete(job.id, width, height, true);
  } catch (_) {
    ChatMathBridge.onRenderComplete(job.id, 0, 0, false);
  }
};
