/**
 * Codex's enabled native surface includes its stable view_image loader. Keep
 * OpenClaw's view_image tool only when that surface or model vision is unavailable.
 */
export function filterCodexVisionTools<T extends { name?: string }>(
  tools: T[],
  params: {
    modelHasVision: boolean;
    nativeImageInspectionEnabled: boolean;
  },
): T[] {
  if (!params.modelHasVision || !params.nativeImageInspectionEnabled) {
    return tools;
  }
  return tools.filter((tool) => tool.name !== "view_image");
}
