import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const CREATE_GITHUB_APP_TOKEN_V3 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

function readWorkflow(path: string) {
  return parse(readFileSync(path, "utf8"));
}

describe("localization catalog authoring workflow", () => {
  it("keeps privileged PR refresh on trusted tooling with exact-head publication", () => {
    const workflow = readWorkflow(".github/workflows/localization-catalog-refresh.yml");
    const steps = workflow.jobs.refresh.steps as WorkflowStep[];
    const resolve = steps.find((step) => step.name === "Resolve trusted tooling and exact source")!;
    const trustedCheckout = steps.find((step) => step.name === "Checkout trusted tooling")!;
    const sourceCheckout = steps.find((step) => step.name === "Checkout exact pull request data")!;
    const baseCheck = steps.find((step) => step.name === "Require current trusted-base catalogs")!;
    const refresh = steps.find((step) => step.name === "Refresh adopted catalog targets")!;
    const validate = steps.find((step) => step.name === "Validate generated catalog targets")!;
    const token = steps.find((step) => step.name === "Create in-place branch token")!;
    const update = steps.find(
      (step) => step.name === "Commit translations to the source pull request",
    )!;
    const fallback = steps.find((step) => step.name === "Open or update generated catalog PR")!;

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.workflow_dispatch.inputs.pull_request_number.required).toBe(false);
    expect(resolve.run).toContain("collaborators/${ACTOR}/permission");
    expect(resolve.run).toContain('.head.repo.full_name "${pr_file}"');
    expect(resolve.run).toContain('.draft "${pr_file}"');
    expect(trustedCheckout.with?.ref).toBe("${{ steps.source.outputs.trusted_sha }}");
    expect(trustedCheckout.with?.["persist-credentials"]).toBe(false);
    expect(sourceCheckout.if).toBe("steps.source.outputs.mode == 'pull-request'");
    expect(sourceCheckout.with?.ref).toBe("${{ steps.source.outputs.source_sha }}");
    expect(sourceCheckout.with?.path).toBe(".localization-source");
    expect(baseCheck.if).toBe("steps.source.outputs.mode == 'pull-request'");
    expect(baseCheck.run).toBe("pnpm localization:catalogs:check");
    expect(refresh.run).toContain("scripts/localization-catalogs.ts refresh --root");
    expect(validate.run).toContain("scripts/localization-catalogs.ts check --root");
    expect(token.uses).toBe(CREATE_GITHUB_APP_TOKEN_V3);
    expect(token.if).toBe("steps.source.outputs.mode == 'pull-request'");
    expect(update.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/pulls/${PULL_REQUEST_NUMBER}"',
    );
    expect(update.run).toContain(".base.ref == env.DEFAULT_BRANCH");
    expect(update.run).toContain(".head.ref == env.HEAD_REF");
    expect(update.run).toContain("--force-with-lease=refs/heads/${HEAD_REF}:${EXPECTED_HEAD_SHA}");
    expect(fallback.if).toBe("steps.source.outputs.mode == 'main'");
    expect(fallback.uses).toBe("./.github/actions/publish-generated-pr");
    expect(fallback.with?.["auto-merge"]).toBe("false");
  });

  it("blocks stale default-base internal PRs and leaves other ready PRs advisory", () => {
    const workflow = readWorkflow(".github/workflows/ci.yml");
    const step = (workflow.jobs["localization-catalogs"].steps as WorkflowStep[]).find(
      (entry) => entry.name === "Check adopted localization catalogs",
    )!;

    expect(step.env).toMatchObject({
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      PR_BASE_REF: "${{ github.event.pull_request.base.ref }}",
      PR_HEAD_REPOSITORY: "${{ github.event.pull_request.head.repo.full_name }}",
      TARGET_REPOSITORY: "${{ github.repository }}",
    });
    expect(step.run).toContain('"$PR_BASE_REF" == "$DEFAULT_BRANCH"');
    expect(step.run).toContain('"$PR_HEAD_REPOSITORY" == "$TARGET_REPOSITORY"');
    expect(step.run).toContain('localization/catalogs.json "${source_paths[@]}"');
    expect(step.run).toContain("pnpm localization:catalogs:gate");
    expect(step.run).toContain("pnpm localization:catalogs:detect");
  });
});
