export type NodeReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
};

export function parseNodeReleaseVersion(value: unknown): NodeReleaseVersion | null;
export function isNodeVersionAtLeast(
  version: NodeReleaseVersion | null,
  minimum: NodeReleaseVersion,
): boolean;
export function isSupportedOpenClawNodeVersion(value: unknown): boolean;
export const OPENCLAW_PROCESS_NODE_VERSION_CHECK: string;
