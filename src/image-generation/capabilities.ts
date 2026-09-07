import type { ImageGenerationProvider } from "./types.js";

export function resolveImageGenerationMaxInputImages(params: {
  provider: Pick<ImageGenerationProvider, "capabilities">;
  model?: string;
}): number | undefined {
  const model = params.model?.trim();
  let prefixLimit: number | undefined;
  let prefixLength = -1;
  if (model) {
    for (const [prefix, limit] of Object.entries(
      params.provider.capabilities.edit.maxInputImagesByModelPrefix ?? {},
    )) {
      if (prefix.length > prefixLength && model.startsWith(prefix)) {
        prefixLimit = limit;
        prefixLength = prefix.length;
      }
    }
  }
  return (
    (model ? params.provider.capabilities.edit.maxInputImagesByModel?.[model] : undefined) ??
    prefixLimit ??
    params.provider.capabilities.edit.maxInputImages
  );
}
