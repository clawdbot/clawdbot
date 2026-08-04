// Shared fake `security find-identity` shim for the macOS signing-identity tests.
// restart-mac and codesign-mac-app assert on the same selection policy from
// opposite sides, and CI hosts have no certificates, so both drive the real
// scripts against these listings through a PATH shim.
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEVELOPER_ID_LISTING = [
  '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Jane Doe (TEAM000001)"',
  '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: Jane Doe (TEAM000001)"',
  '  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Distribution: Jane Doe (TEAM000001)"',
  "     3 valid identities found",
].join("\n");

// Lower-tier classes carry non-Apple noise so the tier loop has to skip an
// unusable entry rather than stop at the first line it sees.
export const APPLE_DISTRIBUTION_LISTING = [
  '  1) DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD "Acme Internal Self-Signed Dev"',
  '  2) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Jane Doe (TEAM000001)"',
  '  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Distribution: Jane Doe (TEAM000001)"',
  "     3 valid identities found",
].join("\n");

export const APPLE_DEVELOPMENT_LISTING = [
  '  1) DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD "Acme Internal Self-Signed Dev"',
  '  2) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Jane Doe (TEAM000001)"',
  "     2 valid identities found",
].join("\n");

// A keychain that `codesign` accepts but that carries none of the Apple
// certificate classes: the case where restart-mac and the packager must agree.
export const NON_APPLE_ONLY_LISTING = [
  '  1) DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD "Acme Internal Self-Signed Dev"',
  "     1 valid identities found",
].join("\n");

// Contains the class text without being that class. A substring match picks it.
export const APPLE_CLASS_LOOKALIKE_LISTING = [
  '  1) EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE "Acme Developer ID Application Proxy"',
  "     1 valid identities found",
].join("\n");

export const EMPTY_LISTING = "     0 valid identities found";

export function installFakeSecurity(binDir: string, listing: string) {
  const fakeSecurity = path.join(binDir, "security");
  writeFileSync(
    fakeSecurity,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "find-identity" ]; then
  cat <<'LISTING'
${listing}
LISTING
  exit 0
fi

echo "unexpected security invocation: $*" >&2
exit 1
`,
  );
  chmodSync(fakeSecurity, 0o755);
}
