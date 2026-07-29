// Lazy image-runtime facade that avoids loading model/provider code until image
// understanding is invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadImageRuntime = createLazyRuntimeModule(() => import("./image.js"));
const bindImageRuntime = createLazyRuntimeMethodBinder(loadImageRuntime);

/** Describes one image through the configured media runtime. */
export const describeImageWithModel = bindImageRuntime((runtime) => runtime.describeImageWithModel);
/** Describes multiple images through the configured media runtime. */
export const describeImagesWithModel = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModel,
);
/** Describes one image after applying the runtime payload transform. */
export const describeImageWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelPayloadTransform,
);
/** Describes multiple images after applying the runtime payload transform. */
export const describeImagesWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelPayloadTransform,
);
