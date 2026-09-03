import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import {
  DERIVED_WORKSPACE_RSYNC_EXCLUDES,
  isDerivedWorkspacePath,
  WORKER_ATTACHMENT_DIRECTORY_PATTERN,
} from "./workspace-path-exclusions.js";

const allocationId = "1234567890abcdef1234567890abcdef";
const nonce = "abcdef0123456789abcdef0123456789";
const identityHash = "f".repeat(64);

describe("worker workspace derived path exclusions", () => {
  it.each([
    "openclaw-inbound-12345678-1234-4234-8234-123456789abc/data.bin",
    `.openclaw-skill-resource-lease-${allocationId}/lease.json`,
    `.openclaw-skill-resource-permit-${allocationId}`,
    `.openclaw-skill-resource-permit-${allocationId}.claimed`,
    `.openclaw-private-publish.${identityHash}.${nonce}.tmp`,
    `.retired-permit.${allocationId}.${nonce}`,
    `.retired-claimed-permit.${allocationId}.${nonce}`,
    `.retired-registry.${allocationId}.${identityHash}.${nonce}/lease.json`,
  ])("excludes an exact allocation runtime path: %s", (relativePath) => {
    expect(isDerivedWorkspacePath(relativePath)).toBe(true);
  });

  it.each([
    "openclaw-inbound-project/data.bin",
    "openclaw-inbound-12345678-1234-4234-8234-123456789ab-/data.bin",
    `.openclaw-skill-resource-lease-${allocationId}x/lease.json`,
    `.openclaw-skill-resource-lease-${allocationId.toUpperCase()}/lease.json`,
    `.openclaw-skill-resource-permit-${allocationId}.claim`,
    `.openclaw-private-publish.${identityHash}.${nonce}x.tmp`,
    `.openclaw-private-publish.${identityHash.slice(1)}.${nonce}.tmp`,
    `.retired-permit.${allocationId}.0.${nonce}`,
    `.retired-registry.${allocationId}.456.789.${nonce}/lease.json`,
    `.retired-registry.${allocationId}.456.789.123.${nonce}x/lease.json`,
  ])("keeps a lookalike user path visible: %s", (relativePath) => {
    expect(isDerivedWorkspacePath(relativePath)).toBe(false);
  });

  it("keeps rsync exclusion patterns aligned with the attachment and ownership namespaces", () => {
    expect(DERIVED_WORKSPACE_RSYNC_EXCLUDES).toContain(WORKER_ATTACHMENT_DIRECTORY_PATTERN);
    expect(DERIVED_WORKSPACE_RSYNC_EXCLUDES).toContain(
      `.openclaw-skill-resource-lease-${"[0-9a-f]".repeat(32)}`,
    );
    for (const relativePath of [
      `.retired-permit.${allocationId}.${nonce}`,
      `.retired-registry.${allocationId}.${identityHash}.${nonce}/lease.json`,
      `.openclaw-private-publish.${identityHash}.${nonce}.tmp`,
    ]) {
      expect(
        relativePath
          .split("/")
          .some((segment) =>
            DERIVED_WORKSPACE_RSYNC_EXCLUDES.some((pattern) =>
              minimatch(segment, pattern, { dot: true }),
            ),
          ),
      ).toBe(true);
    }
    for (const relativePath of [
      `.retired-permit.${allocationId}.0.${nonce}`,
      `.retired-registry.${allocationId}.456.789.123.${nonce}/lease.json`,
      `.openclaw-private-publish.${identityHash}.${nonce}x.tmp`,
    ]) {
      expect(
        relativePath
          .split("/")
          .some((segment) =>
            DERIVED_WORKSPACE_RSYNC_EXCLUDES.some((pattern) =>
              minimatch(segment, pattern, { dot: true }),
            ),
          ),
      ).toBe(false);
    }
  });
});
