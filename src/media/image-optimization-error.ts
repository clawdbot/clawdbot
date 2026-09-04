/** Internal signal that image optimization could not satisfy its final byte budget. */
export class ImageOptimizationLimitError extends Error {
  constructor(
    message: string,
    readonly maxBytes: number,
  ) {
    super(message);
    this.name = "ImageOptimizationLimitError";
  }
}
