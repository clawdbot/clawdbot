const TRUSTED_WORKFLOW_TAG_PATTERN = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;

export function isTrustedWorkflowTag(ref) {
  return TRUSTED_WORKFLOW_TAG_PATTERN.test(ref);
}

export function verifyTrustedWorkflowRef(
  workflowSha,
  trustedWorkflowRef,
  resolveRemoteTagSha = () => "",
  isMainAncestor = () => false,
) {
  if (trustedWorkflowRef === "main") {
    if (!isMainAncestor(workflowSha)) {
      throw new Error(
        `Workflow SHA ${workflowSha} is not reachable from current origin/main; refusing an untrusted release harness.`,
      );
    }
    return;
  }

  const tagMatch = trustedWorkflowRef.match(TRUSTED_WORKFLOW_TAG_PATTERN);
  if (!tagMatch) {
    throw new Error(
      "trusted workflow ref must be main or a protected release-publish/<12hex>-<decimal> tag",
    );
  }
  if (workflowSha.slice(0, 12) !== tagMatch[1]) {
    throw new Error(
      `Trusted workflow tag ${trustedWorkflowRef} does not match Tooling SHA ${workflowSha}`,
    );
  }
  const remoteTagSha = resolveRemoteTagSha(trustedWorkflowRef);
  if (!remoteTagSha) {
    throw new Error(`Trusted workflow tag ${trustedWorkflowRef} does not exist on origin`);
  }
  if (remoteTagSha.toLowerCase() !== workflowSha.toLowerCase()) {
    throw new Error(
      `Trusted workflow tag ${trustedWorkflowRef} resolves to ${remoteTagSha}, expected ${workflowSha}`,
    );
  }
}
