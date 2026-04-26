import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const WORKFLOW_PATH = path.resolve(TEST_DIR, "../../.github/workflows/npm-telegram-beta-e2e.yml");

describe("npm Telegram live Docker E2E", () => {
  it("supports npm-specific Convex credential aliases", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE");
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")');
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_ROLE="$credential_role")');
  });

  it("defaults CI runs to Convex when broker credentials are present", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'if [ -n "${CI:-}" ] && [ -n "${OPENCLAW_QA_CONVEX_SITE_URL:-}" ]; then',
    );
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_CI");
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_MAINTAINER");
    expect(script).toContain('printf "convex"');
  });

  it("installs the npm package before forwarding runtime secrets", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const installRunStart = script.indexOf('echo "Running published npm Telegram live Docker E2E');
    const installRunEnd = script.indexOf('run_logged docker run --rm \\\n  "${docker_env[@]}"');
    const installRun = script.slice(installRunStart, installRunEnd);

    expect(installRun).toContain('npm install -g "$package_spec" --no-fund --no-audit');
    expect(installRun).not.toContain('"${docker_env[@]}"');
    expect(script).toContain('if [ -z "$credential_role" ] && [ -n "${CI:-}" ]');
    expect(script).toContain('credential_role="ci"');
  });

  it("requires release manager environment approval for the manual npm beta workflow", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("approve_release_manager:");
    expect(workflow).toContain("environment: npm-release");
    expect(workflow).toContain("needs: approve_release_manager");
    expect(workflow).not.toContain('new Set(["admin", "write"])');
    expect(workflow).not.toContain("data.role_name");
    expect(workflow).not.toContain("github.rest.teams.listMembersInOrg");
    expect(workflow).not.toContain("getMembershipForUserInOrg");
  });

  it("builds and reuses a local Docker E2E image after approval", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).not.toContain("prepare_docker_e2e_image:");
    expect(workflow).toContain("run_npm_telegram_beta_e2e:");
    expect(workflow).toContain("needs: approve_release_manager");
    expect(workflow).toContain("useblacksmith/setup-docker-builder");
    expect(workflow).toContain("useblacksmith/build-push-action");
    expect(workflow).toContain("tags: openclaw-docker-e2e:local");
    expect(workflow).toContain("load: true");
    expect(workflow).toContain("push: false");
    expect(workflow).not.toContain("cache-from: type=gha");
    expect(workflow).not.toContain("cache-to: type=gha");
    expect(workflow).toContain('OPENCLAW_SKIP_DOCKER_BUILD: "1"');
    expect(workflow).toContain("OPENCLAW_DOCKER_E2E_IMAGE: openclaw-docker-e2e:local");
  });

  it("lets npm-specific credential aliases override shared QA env", () => {
    expect(
      __testing.resolveCredentialSource({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
        OPENCLAW_QA_CREDENTIAL_SOURCE: "env",
      }),
    ).toBe("convex");
    expect(
      __testing.resolveCredentialRole({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
        OPENCLAW_QA_CREDENTIAL_ROLE: "maintainer",
      }),
    ).toBe("ci");
  });
});
