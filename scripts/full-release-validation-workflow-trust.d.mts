export function isTrustedWorkflowTag(ref: string): boolean;

export function verifyTrustedWorkflowRef(
  workflowSha: string,
  trustedWorkflowRef: string,
  resolveRemoteTagSha?: (tag: string) => string,
  isMainAncestor?: (sha: string) => boolean,
): void;
