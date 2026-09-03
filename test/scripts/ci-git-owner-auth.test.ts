import { readFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

async function runAuthFixture(mode: string, script?: string) {
  let stdout = "";
  let stderr = "";
  const code = await runManagedCommand({
    bin: "python3",
    args: [
      "-I",
      "-S",
      "test/scripts/fixtures/ci-checkout-auth.py",
      path.resolve(".github/actions/git-owner/owner.py"),
      mode,
      ...(script ? [script] : []),
    ],
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 30_000,
    timeoutKillGraceMs: 12_000,
    requireProcessTreeExit: true,
    onReady(child) {
      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    },
  });
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}

it.skipIf(process.platform === "win32").each(["fetch-only", "checkout"])(
  "keeps checkout HTTP authentication transient and scoped (%s)",
  async (mode) => {
    expect(await runAuthFixture(mode)).toMatchObject({
      mode,
      fetchAuthenticated: true,
      missingBlobBeforeCheckout: true,
      lazyCheckoutSucceeded: mode === "checkout",
      credentialPersisted: false,
    });
  },
  50_000,
);

function workflowScript(file: string, job: string, name: string) {
  const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8")) as {
    jobs: Record<string, { steps: { name: string; run?: string }[] }>;
  };
  const script = workflow.jobs[job]?.steps.find((step) => step.name === name)?.run;
  return expectDefined(script, "workflow script");
}

it.skipIf(process.platform === "win32").each([
  { mode: "qa-main", code: 0, reason: "main-ancestor" },
  { mode: "qa-main-no-dotgit", code: 0, reason: "main-ancestor" },
  { mode: "qa-exact", code: 0, reason: "repository-branch" },
  { mode: "qa-tag", code: 0, reason: "release-tag" },
  { mode: "qa-branch", code: 0, reason: "release-branch-head" },
  { mode: "qa-mismatch", code: 1, reason: "" },
  { mode: "qa-untrusted", code: 1, reason: "" },
  { mode: "qa-pr", code: 1, reason: "" },
  { mode: "qa-api-error", code: 1, reason: "" },
  { mode: "qa-foreign-origin", code: 125, reason: "" },
])(
  "QA selected-ref validation owns authenticated fetches without changing trust ($mode)",
  async ({ mode, code, reason }) => {
    const report = await runAuthFixture(
      mode,
      workflowScript(
        "qa-live-transports-convex.yml",
        "validate_selected_ref",
        "Validate selected ref",
      ),
    );
    expect(report.exitCode, report.stderr).toBe(code);
    expect(report).toMatchObject({ credentialPersisted: false, trustedReason: reason });
    expect(report.selectedRevisionMatched).toBe(code === 0);
    if (mode === "qa-mismatch" || mode === "qa-foreign-origin") {
      expect(report.requests).toHaveLength(0);
    } else {
      expect(report.requests.length).toBeGreaterThan(0);
      expect(report.fetchAuthenticated).toBe(true);
    }
  },
  50_000,
);

it.skipIf(process.platform === "win32")(
  "Kova checkout is complete after its initial public fetch closes",
  async () => {
    const report = await runAuthFixture(
      "kova",
      workflowScript("openclaw-performance.yml", "kova", "Install OCM and Kova"),
    );
    expect(report.exitCode, report.stderr).toBe(0);
    expect(report).toMatchObject({
      checkoutComplete: true,
      sessions: 1,
      credentialPersisted: false,
    });
    expect(
      report.requests.every(
        (request: { authorizationPresent: boolean }) => !request.authorizationPresent,
      ),
    ).toBe(true);
  },
  50_000,
);
