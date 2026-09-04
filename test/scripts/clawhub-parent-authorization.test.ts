import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  clawHubIdentityFromEnvironment,
  createClawHubParentAuthorization,
  createClawHubRecoveryApproval,
  resolvePackedClawHubArtifactDir,
  validateClawHubIdentity,
  validateClawHubParentAuthorization,
  validateClawHubTransactions,
  validateClawHubWorkflowRun,
} from "../../scripts/clawhub-parent-authorization.mjs";

const sha = "a".repeat(40);
const ref = `release-publish/${sha.slice(0, 12)}-1`;
const recoveryEnv = {
  GITHUB_REPOSITORY: "openclaw/openclaw",
  GITHUB_RUN_ID: "20",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTOR: "octocat",
  RELEASE_PUBLISH_RUN_ID: "10",
  RELEASE_PUBLISH_RUN_ATTEMPT: "2",
};
function transactions(count = 1) {
  return {
    schemaVersion: 1,
    identity: {
      version: 2,
      repository: "openclaw/openclaw",
      workflow: ".github/workflows/plugin-clawhub-release.yml",
      runId: "20",
      runAttempt: "1",
      ref,
      fullRef: `refs/tags/${ref}`,
      sha,
      candidateRepository: "openclaw/openclaw",
      candidateSha: "b".repeat(40),
      toolingRef: "main",
      toolingFullRef: "refs/heads/main",
      toolingSha: sha,
      parentRepository: "openclaw/openclaw",
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      parentRunId: "10",
      parentRunAttempt: "1",
    },
    packages: Array.from({ length: count }, (_, index) => ({
      name: `@openclaw/plugin-${String(index).padStart(3, "0")}`,
      version: "2026.8.2",
      inventoryDigest: "c".repeat(64),
      artifactName: `clawhub-package-${index}`,
      artifactSha256: "d".repeat(64),
      artifactSize: 100,
    })),
  };
}

describe("ClawHub parent publication authorization", () => {
  it("writes an exact human recovery receipt once for the child and parent attempts", () => {
    const receipt = createClawHubRecoveryApproval(recoveryEnv);
    // Mirrors openclaw/clawhub convex/lib/openClawPublishAuthorization.ts RECOVERY_RECEIPT_KEYS.
    const recoveryReceiptKeys = [
      "actor",
      "approvalJob",
      "authorizationRoute",
      "environment",
      "kind",
      "parentRunAttempt",
      "parentRunId",
      "repository",
      "runAttempt",
      "runId",
      "version",
      "workflow",
    ] as const;
    expect(Object.keys(receipt).toSorted()).toEqual(recoveryReceiptKeys);
    expect(receipt).toEqual({
      version: 1,
      kind: "openclaw-clawhub-recovery-approval",
      repository: "openclaw/openclaw",
      workflow: ".github/workflows/plugin-clawhub-release.yml",
      runId: "20",
      runAttempt: "1",
      actor: "octocat",
      environment: "clawhub-plugin-release",
      approvalJob: "approve_plugins_clawhub_release",
      authorizationRoute: "explicit-recovery",
      parentRunId: "10",
      parentRunAttempt: "2",
    });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(8 * 1024);
    for (const actor of ["github-actions[bot]", "Something[Bot]", ""]) {
      expect(() => createClawHubRecoveryApproval({ ...recoveryEnv, GITHUB_ACTOR: actor })).toThrow(
        /human login/u,
      );
    }
    for (const key of [
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "RELEASE_PUBLISH_RUN_ID",
      "RELEASE_PUBLISH_RUN_ATTEMPT",
    ]) {
      for (const value of ["invalid", "0", "01", ""]) {
        expect(() => createClawHubRecoveryApproval({ ...recoveryEnv, [key]: value })).toThrow(
          /invalid/u,
        );
      }
    }
    expect(() =>
      createClawHubRecoveryApproval({ ...recoveryEnv, GITHUB_REPOSITORY: "other/repository" }),
    ).toThrow(/repository/u);
    expect(() =>
      createClawHubRecoveryApproval({ ...recoveryEnv, GITHUB_RUN_ID: "1".repeat(8 * 1024) }),
    ).toThrow(/8 KiB/u);

    const directory = mkdtempSync(join(tmpdir(), "clawhub-recovery-approval-"));
    try {
      const output = join(directory, "approval.json");
      const args = [
        "scripts/clawhub-parent-authorization.mjs",
        "recovery-approval",
        "--output",
        output,
      ];
      const options = { env: { ...process.env, ...recoveryEnv }, encoding: "utf8" } as const;
      const first = spawnSync(process.execPath, args, options);
      expect(first.status, first.stderr).toBe(0);
      const contents = readFileSync(output, "utf8");
      expect(JSON.parse(contents)).toEqual(receipt);
      expect(contents).toBe(`${JSON.stringify(receipt)}\n`);
      const second = spawnSync(process.execPath, args, options);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("EEXIST");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uploads recovery approval only for direct human dispatches from trusted tooling", () => {
    const workflow = parse(
      readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"),
    ) as {
      jobs: Record<
        "approve_plugins_clawhub_release" | "validate_release_publish_approval",
        {
          environment?: string;
          if?: string;
          needs: string[];
          outputs?: Record<string, string>;
          steps: {
            id?: string;
            uses?: string;
            run?: string;
            if?: string;
            with?: Record<string, string>;
          }[];
        }
      >;
    };
    const approval = workflow.jobs.approve_plugins_clawhub_release;
    expect(approval.environment).toBe("clawhub-plugin-release");
    expect(approval.needs).toContain("validate_release_publish_approval");
    expect(approval.if).toContain("needs.validate_release_publish_approval.result == 'success'");
    const validation = workflow.jobs.validate_release_publish_approval;
    expect(validation.outputs?.direct_recovery).toBe(
      "${{ steps.approval.outputs.direct_recovery }}",
    );
    const validationRun = validation.steps.find((step) => step.id === "approval")?.run ?? "";
    const outputWrite = validationRun.indexOf(
      'direct_recovery=${direct_recovery}" >> "$GITHUB_OUTPUT"',
    );
    // The flag is published only after the parent run validated.
    expect(outputWrite).toBeGreaterThan(
      validationRun.indexOf("node scripts/validate-release-publish-approval.mjs"),
    );
    expect(approval.steps).toHaveLength(5);
    expect(approval.steps[0]).not.toHaveProperty("if");
    for (const step of approval.steps.slice(1)) {
      expect(step.if).toBe(
        "needs.validate_release_publish_approval.outputs.direct_recovery == 'true'",
      );
    }
    const checkout = approval.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.workflow_sha }}");
    const write = approval.steps.find((step) => step.run?.includes("recovery-approval --output"));
    expect(write?.run).toContain(
      'recovery-approval --output "$RUNNER_TEMP/openclaw-clawhub-recovery-approval/approval.json"',
    );
    const upload = approval.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const artifactName =
      "openclaw-clawhub-recovery-approval-${{ github.run_id }}-${{ github.run_attempt }}";
    expect(upload?.with?.name).toBe(artifactName);
    expect(upload?.with?.path).toBe(
      "${{ runner.temp }}/openclaw-clawhub-recovery-approval/approval.json",
    );
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });

  it("publishes source metadata for the exact candidate sealed into authorization", () => {
    const workflow = parse(
      readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"),
    ) as {
      jobs: Record<
        string,
        { steps?: { env?: Record<string, string> }[]; with?: Record<string, string> }
      >;
    };
    const candidate = workflow.jobs.seal_clawhub_transactions?.steps?.find(
      (step) => step.env?.TARGET_SHA,
    )?.env?.TARGET_SHA;
    expect(candidate).toBe("${{ needs.preview_plugins_clawhub.outputs.ref_revision }}");
    // ClawHub compares both source fields with the candidate SHA in the publish token.
    expect(workflow.jobs.publish_plugins_clawhub?.with).toMatchObject({
      source_commit: candidate,
      source_ref: candidate,
    });
  });

  it("binds the full release roster beyond 8 KiB without mixing parent and child refs", () => {
    const sealed = transactions(89);
    const receipt = createClawHubParentAuthorization(sealed, "automated-awaited");
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeGreaterThan(8192);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(65536);
    expect(receipt.fullRef).toBe("refs/heads/main");
    expect(receipt.childFullRef).toBe(`refs/tags/${ref}`);
    expect(receipt.packages).toEqual(
      sealed.packages.map(({ name, version, inventoryDigest }) => ({
        name,
        version,
        inventoryDigest,
      })),
    );
    expect(validateClawHubParentAuthorization(receipt, sealed)).toEqual(receipt);
  });

  it.each(["childRunId", "childRunAttempt", "candidateSha", "toolingSha", "childFullRef"])(
    "rejects receipt substitution of %s",
    (key) => {
      const sealed = transactions();
      const receipt = createClawHubParentAuthorization(sealed, "automated-detached");
      expect(() =>
        validateClawHubParentAuthorization({ ...receipt, [key]: "changed" }, sealed),
      ).toThrow(/mismatch/u);
    },
  );

  it("rejects package selection and inventory substitutions", () => {
    const sealed = transactions();
    const receipt = createClawHubParentAuthorization(sealed, "automated-awaited");
    for (const patch of [
      { name: "@openclaw/other" },
      { version: "2026.8.3" },
      { inventoryDigest: "e".repeat(64) },
    ]) {
      expect(() =>
        validateClawHubParentAuthorization(
          { ...receipt, packages: [{ ...receipt.packages[0], ...patch }] },
          sealed,
        ),
      ).toThrow(/mismatch/u);
    }
    expect(() =>
      validateClawHubTransactions({
        ...sealed,
        packages: [...sealed.packages, ...sealed.packages],
      }),
    ).toThrow(/Duplicate/u);
    expect(() => createClawHubParentAuthorization(sealed, "explicit-recovery")).toThrow(/route/u);
  });

  it("rejects branch/tag aliases and different executing tooling", () => {
    const { identity } = transactions();
    expect(() => validateClawHubIdentity({ ...identity, fullRef: `refs/heads/${ref}` })).toThrow(
      /protected/u,
    );
    expect(() => validateClawHubIdentity({ ...identity, sha: "e".repeat(40) })).toThrow();
    expect(() => validateClawHubIdentity({ ...identity, extra: true })).toThrow(/fields/u);
  });

  it("records the executing child context rather than candidate source as producer", () => {
    const { identity } = transactions();
    const env = {
      GITHUB_REPOSITORY: identity.repository,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: identity.runAttempt,
      GITHUB_REF_NAME: identity.ref,
      GITHUB_REF: identity.fullRef,
      GITHUB_WORKFLOW_SHA: identity.sha,
      TARGET_SHA: identity.candidateSha,
      RELEASE_PUBLISH_BRANCH: identity.toolingRef,
      RELEASE_PUBLISH_FULL_REF: identity.toolingFullRef,
      RELEASE_PUBLISH_WORKFLOW_SHA: identity.toolingSha,
      RELEASE_PUBLISH_RUN_ID: identity.parentRunId,
      RELEASE_PUBLISH_RUN_ATTEMPT: identity.parentRunAttempt,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflow}@${identity.fullRef}`,
    };
    expect(clawHubIdentityFromEnvironment(env)).toEqual(identity);
    expect(() =>
      clawHubIdentityFromEnvironment({
        ...env,
        GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflow}@refs/heads/main`,
      }),
    ).toThrow(/context/u);
  });

  it("rejects replaced attempts, cancelled runs, and contradictory qualified refs", () => {
    const { identity } = transactions();
    const run = {
      id: 20,
      run_attempt: 1,
      repository: { full_name: identity.repository },
      head_repository: { full_name: identity.repository },
      event: "workflow_dispatch",
      path: identity.workflow,
      head_sha: sha,
      head_branch: ref,
      status: "completed",
      conclusion: "success",
    };
    expect(validateClawHubWorkflowRun(run, identity, { terminal: true })).toEqual(run);
    for (const patch of [
      { run_attempt: 2 },
      { conclusion: "cancelled" },
      { path: `${identity.workflow}@refs/heads/${ref}` },
      { head_sha: "b".repeat(40) },
    ]) {
      expect(() => validateClawHubWorkflowRun({ ...run, ...patch }, identity)).toThrow();
    }
    expect(() =>
      validateClawHubWorkflowRun({ ...run, status: "in_progress", conclusion: null }, identity, {
        terminal: true,
      }),
    ).toThrow(/state/u);
  });
});

describe("packed ClawHub artifact directories", () => {
  it("reads a lone pattern match from the flat download path", () => {
    const directory = mkdtempSync(join(tmpdir(), "clawhub-packed-"));
    expect(
      resolvePackedClawHubArtifactDir({
        directory,
        artifactName: "clawhub-package-openclaw-arcee-provider-2026.9.1",
        matrixSize: 1,
      }),
    ).toBe(directory);
  });

  it("keeps per-artifact directories for multi-package matrices and nested singles", () => {
    const directory = mkdtempSync(join(tmpdir(), "clawhub-packed-"));
    const nested = join(directory, "clawhub-package-openclaw-arcee-provider-2026.9.1");
    expect(
      resolvePackedClawHubArtifactDir({
        directory,
        artifactName: "clawhub-package-openclaw-arcee-provider-2026.9.1",
        matrixSize: 2,
      }),
    ).toBe(nested);
    mkdirSync(nested);
    expect(
      resolvePackedClawHubArtifactDir({
        directory,
        artifactName: "clawhub-package-openclaw-arcee-provider-2026.9.1",
        matrixSize: 1,
      }),
    ).toBe(nested);
  });
});
