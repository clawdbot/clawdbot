export function isRawCopilotModelRun(params: { modelRun?: boolean; promptMode?: string }): boolean {
  return params.modelRun === true || params.promptMode === "none";
}
