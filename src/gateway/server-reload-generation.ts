let currentReloadGeneration = 0;
let abortGeneration: number | undefined;

export function nextGatewayReloadGeneration(): number {
  return ++currentReloadGeneration;
}

export function isCurrentGatewayReloadGeneration(generation: number): boolean {
  return generation === currentReloadGeneration;
}

export function isGatewayReloadGenerationAborted(generation: number): boolean {
  return abortGeneration !== undefined && generation <= abortGeneration;
}

/** Signal any in-progress deferred channel reload to abort immediately. */
export function abortPendingChannelReloads(): void {
  abortGeneration = currentReloadGeneration;
}
