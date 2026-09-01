// MXC doctor contract warns about policy files that will fail the bounded loader after upgrade.
import { statSync } from "node:fs";
import { MAX_SANDBOX_POLICY_FILE_BYTES } from "./src/sandbox-policy-loader.js";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown, root: Record<string, unknown>) => boolean;
};

const MXC_POLICY_PATHS = ["plugins", "entries", "mxc", "config", "mxcPolicyPaths"];
const MXC_POLICY_SIZE_MESSAGE =
  `Configured MXC policy files include a file larger than ${MAX_SANDBOX_POLICY_FILE_BYTES} bytes (1 MiB). ` +
  "Reduce each file to 1 MiB or less or remove it from plugins.entries.mxc.config.mxcPolicyPaths before upgrading; do not rely on a silent fallback.";

function hasOversizedPolicyFile(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      return false;
    }
    try {
      const stats = statSync(entry.trim());
      return stats.isFile() && stats.size > MAX_SANDBOX_POLICY_FILE_BYTES;
    } catch {
      return false;
    }
  });
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: MXC_POLICY_PATHS,
    message: MXC_POLICY_SIZE_MESSAGE,
    match: hasOversizedPolicyFile,
  },
];
