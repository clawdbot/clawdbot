import path from "node:path";
import {
  buildFactoryNativeLaunchAuthority,
  buildFactoryNativeProofHash,
  buildFactoryNativeRuntimePolicyHash,
  hashFactoryNativeAuthorityValue,
} from "./factory-authority-profile.js";
import type {
  SwarmEffectiveAuthorityProof,
  SwarmLaunchAuthority,
} from "./subagent-registry.types.js";

const TEST_HASH = `sha256:${"1".repeat(64)}` as const;

export function buildTestFactoryNativeAuthority(root: string): SwarmLaunchAuthority {
  const canonicalRoot = path.resolve(root);
  const cwd = path.join(canonicalRoot, "worktree");
  const factoryStateRoot = path.join(canonicalRoot, "factory-state");
  const attemptRoot = path.join(factoryStateRoot, "attempts", "swarm_test");
  const scratchRoot = path.join(attemptRoot, "scratch");
  return buildFactoryNativeLaunchAuthority({
    cwd,
    workspaceRoot: cwd,
    paths: {
      factoryStateRoot,
      attemptRoot,
      scratchRoot,
      sanitizedHome: path.join(scratchRoot, "home"),
      tempDir: path.join(scratchRoot, "tmp"),
    },
    manifest: {
      readableRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew"],
      pathEntries: ["/usr/bin"],
      environment: {},
    },
    gitMetadataRoot: path.join(canonicalRoot, "repository", ".git"),
    worktreeFenceToken: "fence-1",
    worktreeOwnershipGeneration: 7,
  });
}

export function buildTestFactoryNativeAuthorityProof(params: {
  authority: SwarmLaunchAuthority;
  launchIdentityDigest: `sha256:${string}`;
}): SwarmEffectiveAuthorityProof {
  const runtimeWithoutPolicyHash = {
    codexVersion: "test",
    appServerVersion: "test",
    appServerInstanceId: "factory-test-instance",
    appServerPid: 123,
    appServerBuildIdentity: "git:test",
    runtimeArtifactId: "factory-test-runtime",
    runtimeArtifactFingerprint: "factory-test-runtime-fingerprint",
    activePermissionProfile: { id: params.authority.permissionProfile.id },
    sandbox: {
      type: "workspaceWrite" as const,
      writableRoots: params.authority.filesystem.writableRoots
        .filter((root) => root !== params.authority.cwd)
        .toSorted(),
      networkAccess: false as const,
      excludeTmpdirEnvVar: true as const,
      excludeSlashTmp: true as const,
    },
    profileDefinitionHash: params.authority.permissionProfile.definitionHash,
    threadConfigHash: TEST_HASH,
    shellEnvironmentPolicyHash: params.authority.shellEnvironmentPolicy.definitionHash,
    dynamicTools: [...params.authority.toolSurface.openClawDynamicTools],
    cwd: params.authority.cwd,
    runtimeWorkspaceRoots: [...params.authority.filesystem.writableRoots],
    approvalPolicy: params.authority.approvalPolicy,
    approvalsReviewer: params.authority.approvalsReviewer,
    permissionSelection: params.authority.permissionProfile.id,
    threadStartRequestHash: TEST_HASH,
    turnStartRequestHash: TEST_HASH,
  };
  const runtime: SwarmEffectiveAuthorityProof["runtime"] = {
    ...runtimeWithoutPolicyHash,
    policyHash: buildFactoryNativeRuntimePolicyHash({
      ...runtimeWithoutPolicyHash,
      policyHash: TEST_HASH,
    }),
  };
  const withoutProofHash = {
    proofContractVersion: 1 as const,
    contractHash: hashFactoryNativeAuthorityValue(params.authority),
    launchIdentityDigest: params.launchIdentityDigest,
    runtime,
    observedAt: 1_700_000_000_050,
  };
  return {
    ...withoutProofHash,
    proofHash: buildFactoryNativeProofHash(withoutProofHash),
  };
}
