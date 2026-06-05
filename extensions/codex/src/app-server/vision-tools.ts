/**
 * Filters Codex dynamic tools for turns that already contain image inputs so
 * models with native vision do not get redundant image-inspection tools.
 */
/** Removes the image tool when the model can directly consume inbound images. */
export function filterToolsForVisionInputs<T extends { name?: string }>(
  tools: T[],
  params: {
    modelHasVision: boolean;
    hasInboundImages: boolean;
  },
): T[] {
  if (!params.modelHasVision || !params.hasInboundImages) {
    return tools;
  }
  return tools.filter((tool) => tool.name !== "image");
}
