export function selectSessionTabToUntrack(params: {
  volatileAvailable: boolean;
  durableAvailable: boolean;
  hasVolatileCandidate: boolean;
  hasDurableCandidate: boolean;
  volatileIsExact: boolean;
  durableIsExact: boolean;
  hasVolatileExactCandidate: boolean;
  hasDurableExactCandidate: boolean;
}): "volatile" | "durable" | "ambiguous" | "missing" {
  if (params.volatileIsExact && !params.hasDurableExactCandidate) {
    return "volatile";
  }
  if (params.durableIsExact && !params.hasVolatileExactCandidate) {
    return "durable";
  }
  if (params.hasVolatileCandidate && params.hasDurableCandidate) {
    return "ambiguous";
  }
  if (params.volatileAvailable) {
    return "volatile";
  }
  if (params.durableAvailable) {
    return "durable";
  }
  if (params.hasVolatileCandidate || params.hasDurableCandidate) {
    return "ambiguous";
  }
  return "missing";
}
