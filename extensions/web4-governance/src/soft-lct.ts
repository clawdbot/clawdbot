/**
 * Soft LCT - Software-bound Linked Context Token.
 *
 * Generates a session identity token from machine + user context.
 * NOT hardware-bound (no TPM/SE). Trust interpretation is up to
 * the relying party.
 */

import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

export type SoftLCTToken = {
  tokenId: string;
  sessionId: string;
  machineHash: string;
  createdAt: string;
  bindingType: "software";
};

export function createSoftLCT(sessionId: string): SoftLCTToken {
  const machine = hostname();
  const user = userInfo().username;
  const machineHash = createHash("sha256")
    .update(`${machine}:${user}`)
    .digest("hex")
    .slice(0, 8);

  return {
    tokenId: `web4:session:${machineHash}:${sessionId.slice(0, 8)}`,
    sessionId,
    machineHash,
    createdAt: new Date().toISOString(),
    bindingType: "software",
  };
}
