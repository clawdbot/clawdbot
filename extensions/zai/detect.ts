import {
  detectZaiEndpoint as detectZaiEndpointCore,
  type ZaiDetectedEndpoint,
  type ZaiEndpointId,
} from "./runtime-api.js";

type DetectZaiEndpointFn = typeof detectZaiEndpointCore;

let detectZaiEndpointImpl: DetectZaiEndpointFn = detectZaiEndpointCore;

export async function detectZaiEndpoint(
  ...args: Parameters<DetectZaiEndpointFn>
): ReturnType<DetectZaiEndpointFn> {
  return await detectZaiEndpointImpl(...args);
}

export type { ZaiDetectedEndpoint, ZaiEndpointId };
