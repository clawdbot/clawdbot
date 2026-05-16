import { describe, expect, it } from "vitest";
import {
  buildPublishCommand,
  parseArgs,
  parseRunIdFromDispatchOutput,
} from "../../scripts/release-candidate-checklist.mjs";

describe("release candidate checklist", () => {
  it("requires run ids when dispatch is disabled", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14-beta.3", "--skip-dispatch"])).toThrow(
      "--skip-dispatch requires --full-release-run and --npm-preflight-run",
    );
  });

  it("builds the gated release publish command from green evidence inputs", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "release/2026.5.14",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
      ]),
      workflowRef: "release/2026.5.14",
    };

    expect(buildPublishCommand(options)).toContain("'full_release_validation_run_id=111'");
    expect(buildPublishCommand(options)).toContain("'preflight_run_id=222'");
    expect(buildPublishCommand(options)).toContain("'tag=v2026.5.14-beta.3'");
    expect(buildPublishCommand(options)).toContain("'plugin_publish_scope=all-publishable'");
  });

  it("requires explicit plugin names for selected plugin publish scope", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-publish-scope", "selected"]),
    ).toThrow("--plugin-publish-scope selected requires --plugins");
  });

  it("extracts a workflow run id from gh dispatch output", () => {
    expect(
      parseRunIdFromDispatchOutput(
        "https://github.com/openclaw/openclaw/actions/runs/25922042055\n",
      ),
    ).toBe("25922042055");
  });
});
