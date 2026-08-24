import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";

const HEX_DIGEST = /sha256:[0-9a-f]{64}/g;
const BYTE_LENGTH = /"byteLength":\d+/g;

/**
 * Golden-plan test support. Plans embed opaque digests that hash absolute paths
 * (workspace, package root, planIntegrity), and those paths differ across hosts
 * and CI. A digest value cannot be normalized after the fact, so the golden
 * projection replaces every 64-hex sha256 value with a placeholder: the shape,
 * action sets, classifications, blocked/manual states, consent structure, and
 * digest placement stay pinned machine-stably. Individual digest correctness is
 * covered by the behavior tests in update-plan.test.ts and siblings. Short
 * fixture digests such as sha256:base are stable inputs and stay literal.
 *
 * byteLength is also placeholderized: it counts raw on-disk bytes of the Claw
 * source and shifts with checkout line endings (CRLF vs LF), which is exactly
 * the kind of environment noise a golden must not pin.
 */
export function normalizeGoldenPlan(plan: unknown, roots: string[]): string {
  let text = stableStringify(plan);
  for (const root of roots) {
    text = text.replaceAll(root, "<ROOT>");
  }
  return text.replaceAll(HEX_DIGEST, "sha256:<DIGEST>").replaceAll(BYTE_LENGTH, '"byteLength":<N>');
}

export function goldenPlanDigest(normalized: string): string {
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}
