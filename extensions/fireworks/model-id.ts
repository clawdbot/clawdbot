export function isFireworksKimiModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^kimi-k2(?:p5|\.5)(?:[-_].+)?$/.test(lastSegment);
}
