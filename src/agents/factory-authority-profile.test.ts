import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertFactoryNativeAuthorityProof,
  assertFactoryNativeLaunchAuthority,
  buildFactoryNativeLaunchAuthority,
  buildFactoryNativeProofHash,
  buildFactoryNativeRuntimePolicyHash,
  canonicalizeFactoryNativeAuthorityManifest,
  FACTORY_NATIVE_BASE_PATH_ENTRIES,
} from "./factory-authority-profile.js";
import {
  buildTestFactoryNativeAuthority,
  buildTestFactoryNativeAuthorityProof,
} from "./factory-authority-profile.test-helpers.js";

const ROOT = "/tmp/openclaw-factory-authority-test";
const LAUNCH_DIGEST = `sha256:${"a".repeat(64)}` as const;

describe("factory native authority profile", () => {
  it("preserves caller toolchain precedence and appends only the fixed safe fallback", () => {
    const authority = buildFactoryNativeLaunchAuthority({
      cwd: `${ROOT}/worktree`,
      workspaceRoot: `${ROOT}/worktree`,
      paths: {
        factoryStateRoot: `${ROOT}/factory-state`,
        attemptRoot: `${ROOT}/factory-state/attempts/run-1`,
        scratchRoot: `${ROOT}/factory-state/attempts/run-1/scratch`,
        sanitizedHome: `${ROOT}/factory-state/attempts/run-1/scratch/home`,
        tempDir: `${ROOT}/factory-state/attempts/run-1/scratch/tmp`,
      },
      manifest: {
        readableRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew"],
        pathEntries: ["/opt/homebrew/opt/elixir/bin", "/opt/homebrew/opt/node@24/bin"],
        environment: { MIX_ENV: "test" },
      },
      gitMetadataRoot: `${ROOT}/repository/.git`,
      worktreeFenceToken: "fence-1",
      worktreeOwnershipGeneration: 1,
    });

    expect(authority.shellEnvironmentPolicy.orderedNativePathEntries).toEqual([
      "/opt/homebrew/opt/elixir/bin",
      "/opt/homebrew/opt/node@24/bin",
    ]);
    expect(authority.shellEnvironmentPolicy.effectivePath.split(":")).toEqual([
      "/opt/homebrew/opt/elixir/bin",
      "/opt/homebrew/opt/node@24/bin",
      ...FACTORY_NATIVE_BASE_PATH_ENTRIES,
    ]);
    expect(authority.shellEnvironmentPolicy.effectivePath).not.toContain("/usr/local/bin");
    expect(authority.network).toBe("none");
    expect(authority.approvalsReviewer).toBe("auto_review");
    expect(authority.permissionProfile.definition.network).toEqual({ enabled: false });
    expect(authority.permissionProfile.platformDefaultTempAccess).toBe("read_write");
  });

  it("rejects secret-bearing environment names", () => {
    expect(() =>
      buildFactoryNativeLaunchAuthority({
        cwd: `${ROOT}/worktree`,
        workspaceRoot: `${ROOT}/worktree`,
        paths: {
          factoryStateRoot: `${ROOT}/factory-state`,
          attemptRoot: `${ROOT}/factory-state/attempts/run-1`,
          scratchRoot: `${ROOT}/factory-state/attempts/run-1/scratch`,
          sanitizedHome: `${ROOT}/factory-state/attempts/run-1/scratch/home`,
          tempDir: `${ROOT}/factory-state/attempts/run-1/scratch/tmp`,
        },
        manifest: {
          readableRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew"],
          pathEntries: ["/usr/bin"],
          environment: { API_TOKEN: "must-not-cross-the-boundary" },
        },
        gitMetadataRoot: `${ROOT}/repository/.git`,
        worktreeFenceToken: "fence-1",
        worktreeOwnershipGeneration: 1,
      }),
    ).toThrow("environment variable is not approved");
  });

  it("rejects unrelated system read roots", () => {
    expect(() =>
      buildFactoryNativeLaunchAuthority({
        cwd: `${ROOT}/worktree`,
        workspaceRoot: `${ROOT}/worktree`,
        paths: {
          factoryStateRoot: `${ROOT}/factory-state`,
          attemptRoot: `${ROOT}/factory-state/attempts/run-1`,
          scratchRoot: `${ROOT}/factory-state/attempts/run-1/scratch`,
          sanitizedHome: `${ROOT}/factory-state/attempts/run-1/scratch/home`,
          tempDir: `${ROOT}/factory-state/attempts/run-1/scratch/tmp`,
        },
        manifest: {
          readableRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew", "/private/etc"],
          pathEntries: ["/usr/bin"],
          environment: {},
        },
        gitMetadataRoot: `${ROOT}/repository/.git`,
        worktreeFenceToken: "fence-1",
        worktreeOwnershipGeneration: 1,
      }),
    ).toThrow("system read root is outside the approved toolchain area");
  });

  it("allows only descendants of the owner-controlled factory input root", async () => {
    const fakeHome = mkdtempSync("/private/tmp/openclaw-factory-input-test-");
    const stateRoot = path.join(fakeHome, "Library", "Application Support", "OpenClawFactory");
    const inputRoot = path.join(stateRoot, "control", "inputs", "recognition-corpus");
    const siblingRoot = path.join(stateRoot, "control", "secrets");
    mkdirSync(inputRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      const manifest = await canonicalizeFactoryNativeAuthorityManifest({
        readableRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew", inputRoot],
        pathEntries: ["/usr/bin"],
        environment: {},
        factoryStateRoot: stateRoot,
      });
      expect(manifest.readableRoots).toContain(inputRoot);

      await expect(
        canonicalizeFactoryNativeAuthorityManifest({
          readableRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew", siblingRoot],
          pathEntries: ["/usr/bin"],
          environment: {},
          factoryStateRoot: stateRoot,
        }),
      ).rejects.toThrow("user read root is outside the approved toolchain area");
      await expect(
        canonicalizeFactoryNativeAuthorityManifest({
          readableRoots: [
            "/Library/Developer/CommandLineTools",
            "/opt/homebrew",
            path.join(stateRoot, "control"),
          ],
          pathEntries: ["/usr/bin"],
          environment: {},
          factoryStateRoot: stateRoot,
        }),
      ).rejects.toThrow("user read root is outside the approved toolchain area");
    } finally {
      homeSpy.mockRestore();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("rejects persisted launch-authority drift", () => {
    const authority = buildTestFactoryNativeAuthority(ROOT);
    const drifted = structuredClone(authority) as unknown as Record<string, unknown>;
    drifted.network = "host";

    expect(() => assertFactoryNativeLaunchAuthority(drifted)).toThrow(
      "does not match the enforced profile",
    );

    const reviewerDrifted = structuredClone(authority) as unknown as Record<string, unknown>;
    reviewerDrifted.approvalsReviewer = "user";
    expect(() => assertFactoryNativeLaunchAuthority(reviewerDrifted)).toThrow(
      /contract is invalid|does not match the enforced profile/u,
    );
  });

  it("accepts an exact runtime proof and rejects active-profile inheritance", () => {
    const authority = buildTestFactoryNativeAuthority(ROOT);
    const proof = buildTestFactoryNativeAuthorityProof({
      authority,
      launchIdentityDigest: LAUNCH_DIGEST,
    });
    const binding = {
      runId: `swarm_${"b".repeat(32)}`,
      launchIdentityDigest: LAUNCH_DIGEST,
      authority,
    };

    expect(assertFactoryNativeAuthorityProof({ binding, proof })).toEqual(proof);
    expect(proof.runtime.runtimeWorkspaceRoots).toEqual(authority.filesystem.writableRoots);
    expect(proof.runtime.approvalsReviewer).toBe("auto_review");
    expect(proof.runtime.sandbox.writableRoots).toEqual(
      authority.filesystem.writableRoots.filter((root) => root !== authority.cwd),
    );
    const drifted = structuredClone(proof);
    drifted.runtime.activePermissionProfile.extends = "default";
    expect(() => assertFactoryNativeAuthorityProof({ binding, proof: drifted })).toThrow(
      "does not match the launch contract",
    );

    const sandboxDrifted = structuredClone(proof) as unknown as {
      runtime: { sandbox: { networkAccess: boolean } };
    };
    sandboxDrifted.runtime.sandbox.networkAccess = true;
    expect(() =>
      assertFactoryNativeAuthorityProof({
        binding,
        proof: sandboxDrifted as unknown as typeof proof,
      }),
    ).toThrow("does not match the launch contract");

    const legacyProjectionDrifted = structuredClone(proof);
    legacyProjectionDrifted.runtime.sandbox.writableRoots = [...authority.filesystem.writableRoots];
    legacyProjectionDrifted.runtime.policyHash = buildFactoryNativeRuntimePolicyHash(
      legacyProjectionDrifted.runtime,
    );
    legacyProjectionDrifted.proofHash = buildFactoryNativeProofHash({
      proofContractVersion: legacyProjectionDrifted.proofContractVersion,
      contractHash: legacyProjectionDrifted.contractHash,
      launchIdentityDigest: legacyProjectionDrifted.launchIdentityDigest,
      runtime: legacyProjectionDrifted.runtime,
      observedAt: legacyProjectionDrifted.observedAt,
    });
    expect(() =>
      assertFactoryNativeAuthorityProof({ binding, proof: legacyProjectionDrifted }),
    ).toThrow("does not match the launch contract");

    const reviewerDrifted = structuredClone(proof) as unknown as Omit<typeof proof, "runtime"> & {
      runtime: Omit<typeof proof.runtime, "approvalsReviewer"> & { approvalsReviewer: string };
    };
    reviewerDrifted.runtime.approvalsReviewer = "user";
    reviewerDrifted.runtime.policyHash = buildFactoryNativeRuntimePolicyHash(
      reviewerDrifted.runtime as typeof proof.runtime,
    );
    reviewerDrifted.proofHash = buildFactoryNativeProofHash({
      proofContractVersion: reviewerDrifted.proofContractVersion,
      contractHash: reviewerDrifted.contractHash,
      launchIdentityDigest: reviewerDrifted.launchIdentityDigest,
      runtime: reviewerDrifted.runtime as typeof proof.runtime,
      observedAt: reviewerDrifted.observedAt,
    });
    expect(() =>
      assertFactoryNativeAuthorityProof({
        binding,
        proof: reviewerDrifted as typeof proof,
      }),
    ).toThrow("does not match the launch contract");
  });
});
