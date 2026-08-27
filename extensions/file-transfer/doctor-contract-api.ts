import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function hasLegacyPositivePolicy(value: unknown): boolean {
  const config = asNullableRecord(value);
  if (!config || config.policyVersion === 2) {
    return false;
  }
  const nodes = asNullableRecord(config.nodes);
  if (!nodes) {
    return false;
  }
  return Object.values(nodes).some((rawNode) => {
    const node = asNullableRecord(rawNode);
    return Boolean(
      node &&
      ((Array.isArray(node.allowReadPaths) && node.allowReadPaths.length > 0) ||
        (Array.isArray(node.allowWritePaths) && node.allowWritePaths.length > 0)),
    );
  });
}

export const legacyConfigRules = [
  {
    path: ["plugins", "entries", "file-transfer", "config"],
    message:
      'File-transfer permissions need review and remain inactive. Run "openclaw file-transfer approvals migrate".',
    match: hasLegacyPositivePolicy,
  },
];
