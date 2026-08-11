// Lazy image-runtime facade that avoids loading model/provider code until image
// understanding is invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadImageRuntime = createLazyRuntimeModule(() => import("./image.js"));
const bindImageRuntime = createLazyRuntimeMethodBinder(loadImageRuntime);

/** Describes one image through the configured media runtime. */
export const describeImageWithModel = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelCore,
);
/** Describes multiple images through the configured media runtime. */
export const describeImagesWithModel = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelCore,
);
/** Describes one image after applying the runtime payload transform. */
export const describeImageWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelPayloadTransformCore,
);
/** Describes multiple images after applying the runtime payload transform. */
export const describeImagesWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelPayloadTransformCore,
);
