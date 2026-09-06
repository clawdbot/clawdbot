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
  GITHUB_RUN_ID: "30",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTOR: "octocat",
  RELEASE_PUBLISH_RUN_ID: "10",
  RELEASE_PUBLISH_RUN_ATTEMPT: "2",
  RECOVERED_CLAWHUB_RUN_ID: "20",
  RECOVERED_CLAWHUB_RUN_ATTEMPT: "1",
};
const noGh = () => {
  throw new Error("unexpected GitHub lookup");
};
function parentArtifacts(names: string[], total = names.length) {
  return (path: string) => {
    expect(path).toMatch(/^actions\/runs\/10\/artifacts\?per_page=100&page=[1-9]/u);
    const page = Number(/page=(\d+)$/u.exec(path)?.[1]);
    return {
      total_count: total,
      artifacts: names.slice((page - 1) * 100, page * 100).map((name) => ({ name })),
    };
  };
}
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
    const receipt = createClawHubRecoveryApproval(recoveryEnv, noGh);
    // Mirrors openclaw/clawhub convex/lib/openClawPublishAuthorization.ts RECOVERY_RECEIPT_KEYS.
    const recoveryReceiptKeys = [
      "actor",
      "approvalJob",
      "authorizationRoute",
      "authorizedChildRunAttempt",
      "authorizedChildRunId",
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
      version: 2,
      kind: "openclaw-clawhub-recovery-approval",
      repository: "openclaw/openclaw",
      workflow: ".github/workflows/plugin-clawhub-release.yml",
      runId: "30",
      runAttempt: "1",
      actor: "octocat",
      environment: "clawhub-plugin-release",
      approvalJob: "approve_plugins_clawhub_release",
      authorizationRoute: "explicit-recovery",
      parentRunId: "10",
      parentRunAttempt: "2",
      authorizedChildRunId: "20",
      authorizedChildRunAttempt: "1",
    });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(8 * 1024);
    for (const actor of ["github-actions[bot]", "Something[Bot]", ""]) {
      expect(() =>
        createClawHubRecoveryApproval({ ...recoveryEnv, GITHUB_ACTOR: actor }, noGh),
      ).toThrow(/human login/u);
    }
    for (const key of [
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "RELEASE_PUBLISH_RUN_ID",
      "RELEASE_PUBLISH_RUN_ATTEMPT",
    ]) {
      for (const value of ["invalid", "0", "01", ""]) {
        expect(() => createClawHubRecoveryApproval({ ...recoveryEnv, [key]: value }, noGh)).toThrow(
          /invalid/u,
        );
      }
    }
    // Explicit recovered-child inputs are validated as a pair; one half never falls back to discovery.
    for (const key of ["RECOVERED_CLAWHUB_RUN_ID", "RECOVERED_CLAWHUB_RUN_ATTEMPT"]) {
      for (const value of ["invalid", "0", "01", " ", "", "1.5"]) {
        expect(() => createClawHubRecoveryApproval({ ...recoveryEnv, [key]: value }, noGh)).toThrow(
          /Recovered ClawHub run (id|attempt) is invalid/u,
        );
      }
    }
    expect(() =>
      createClawHubRecoveryApproval(
        { ...recoveryEnv, GITHUB_REPOSITORY: "other/repository" },
        noGh,
      ),
    ).toThrow(/repository/u);
    expect(() =>
      createClawHubRecoveryApproval({ ...recoveryEnv, GITHUB_RUN_ID: "1".repeat(8 * 1024) }, noGh),
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

  it("discovers the authorized child from the parent attempt's single v2 receipt", () => {
    const env = { ...recoveryEnv, RECOVERED_CLAWHUB_RUN_ID: "", RECOVERED_CLAWHUB_RUN_ATTEMPT: "" };
    const receiptName = "openclaw-clawhub-parent-authorization-v2-10-2-21-3";
    const unrelated = [
      "openclaw-release-children-10-2",
      "openclaw-clawhub-parent-authorization-v2-10-1-20-1",
      "openclaw-clawhub-parent-authorization-v2-11-2-22-1",
      "openclaw-clawhub-transactions-21-3",
    ];
    const discovered = createClawHubRecoveryApproval(
      env,
      parentArtifacts([...unrelated, receiptName]),
    );
    expect(discovered).toMatchObject({
      authorizedChildRunId: "21",
      authorizedChildRunAttempt: "3",
      parentRunId: "10",
      parentRunAttempt: "2",
    });
    // Receipts land on later pages of a full release inventory.
    const padded = Array.from({ length: 150 }, (_, index) => `clawhub-package-${index}`);
    expect(
      createClawHubRecoveryApproval(env, parentArtifacts([...padded, receiptName])),
    ).toMatchObject({ authorizedChildRunId: "21", authorizedChildRunAttempt: "3" });
    expect(() => createClawHubRecoveryApproval(env, parentArtifacts(unrelated))).toThrow(
      /has no openclaw-clawhub-parent-authorization-v2-10-2-\* receipt; pass recovered_clawhub_run_id and recovered_clawhub_run_attempt/u,
    );
    const rival = "openclaw-clawhub-parent-authorization-v2-10-2-25-1";
    expect(() => createClawHubRecoveryApproval(env, parentArtifacts([receiptName, rival]))).toThrow(
      new RegExp(`ambiguous receipts \\(${receiptName}, ${rival}\\)`, "u"),
    );
    expect(() =>
      createClawHubRecoveryApproval(
        env,
        parentArtifacts(["openclaw-clawhub-parent-authorization-v2-10-2-021-3"]),
      ),
    ).toThrow(/Malformed parent authorization receipt name/u);
    expect(() => createClawHubRecoveryApproval(env, parentArtifacts([receiptName], 2))).toThrow(
      /Incomplete release parent artifact inventory/u,
    );
    // Explicit inputs win without any parent lookup.
    expect(createClawHubRecoveryApproval(recoveryEnv, noGh)).toMatchObject({
      authorizedChildRunId: "20",
      authorizedChildRunAttempt: "1",
    });
  });

  it("uploads recovery approval only for direct human dispatches from trusted tooling", () => {
    const workflow = parse(
      readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"),
    ) as {
      on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } };
      jobs: Record<
        "approve_plugins_clawhub_release" | "validate_release_publish_approval",
        {
          environment?: string;
          if?: string;
          needs: string[];
          outputs?: Record<string, string>;
          permissions?: Record<string, string>;
          steps: {
            id?: string;
            uses?: string;
            run?: string;
            if?: string;
            env?: Record<string, string>;
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
    // Discovery lists the parent run's receipts, so the job needs a token and actions:read.
    expect(approval.permissions).toEqual({ actions: "read", contents: "read" });
    expect(write?.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      RECOVERED_CLAWHUB_RUN_ID: "${{ inputs.recovered_clawhub_run_id }}",
      RECOVERED_CLAWHUB_RUN_ATTEMPT: "${{ inputs.recovered_clawhub_run_attempt }}",
    });
    for (const input of ["recovered_clawhub_run_id", "recovered_clawhub_run_attempt"]) {
      expect(workflow.on.workflow_dispatch.inputs[input]).toMatchObject({
        required: false,
        default: "",
        type: "string",
      });
    }
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
