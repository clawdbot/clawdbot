import {
  readHelperResults,
  type FaceTimeHelperPeer,
  type HelperActionResult,
} from "./helper-rpc.js";
import type { ActiveFaceTimeCall } from "./runtime-state.js";

export const OUTBOUND_DIAL_HELPER_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);

export function readHelperPeers(result: HelperActionResult): FaceTimeHelperPeer[] {
  const peers: FaceTimeHelperPeer[] = [];
  for (const entry of readHelperResults(result)) {
    const peer = entry.helperPeer;
    if (
      peer &&
      typeof peer === "object" &&
      "processId" in peer &&
      "bundleIdentifier" in peer &&
      "connectionGeneration" in peer &&
      "processStartedAtMs" in peer &&
      typeof peer.processId === "number" &&
      typeof peer.bundleIdentifier === "string" &&
      typeof peer.connectionGeneration === "number" &&
      typeof peer.processStartedAtMs === "number"
    ) {
      peers.push({
        bundleIdentifier: peer.bundleIdentifier,
        processId: peer.processId,
        processStartedAtMs: peer.processStartedAtMs,
        connectionGeneration: peer.connectionGeneration,
      });
    }
  }
  return peers;
}

export function retainHelperResultPeers(
  call: ActiveFaceTimeCall,
  result: HelperActionResult,
): void {
  for (const peer of readHelperPeers(result)) {
    call.carrierPeers.set(peer.processId, peer);
  }
}

export function readOutboundCallUUID(result: HelperActionResult): string | undefined {
  return readHelperResults(result)
    .map((entry) =>
      typeof entry.call_uuid === "string" && entry.call_uuid.trim()
        ? entry.call_uuid.trim()
        : undefined,
    )
    .find((value) => Boolean(value));
}

export function readOutboundProxyIdentifier(result: HelperActionResult): string | undefined {
  return readHelperResults(result)
    .map((entry) =>
      typeof entry.proxy_identifier === "string" && entry.proxy_identifier.trim()
        ? entry.proxy_identifier.trim()
        : undefined,
    )
    .find((value) => Boolean(value));
}

export function hasDialHelperConfirmation(results: HelperActionResult[]): boolean {
  return results.some(
    (entry) =>
      typeof entry.helperBundleIdentifier === "string" &&
      OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier),
  );
}

export function hasDefinitiveDialHelperAbsence(results: HelperActionResult[]): boolean {
  return results.some(
    (entry) =>
      typeof entry.helperBundleIdentifier === "string" &&
      OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier) &&
      entry.found === false &&
      entry.retained_outbound_dial !== true,
  );
}
