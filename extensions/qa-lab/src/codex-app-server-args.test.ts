import { describe, expect, it } from "vitest";
import { buildQaCodexAppServerArgs } from "./codex-app-server-args.js";

describe("native Codex QA app-server arguments", () => {
  it("keeps live Codex QA workspaces confined without overriding provider routing", () => {
    expect(buildQaCodexAppServerArgs()).toBe(
      "app-server -c sandbox_workspace_write.exclude_tmpdir_env_var=true " +
        "-c sandbox_workspace_write.exclude_slash_tmp=true --listen stdio://",
    );
  });

  it("preserves existing live-provider, transport, and model-catalog arguments", () => {
    expect(
      buildQaCodexAppServerArgs({
        existingArgs:
          'app-server -c openai_base_url="https://live.example/v1" ' +
          '-c "model_catalog_json=/tmp/live models.json" --listen stdio://',
      }),
    ).toBe(
      'app-server -c openai_base_url="https://live.example/v1" ' +
        '-c "model_catalog_json=/tmp/live models.json" --listen stdio:// ' +
        "-c sandbox_workspace_write.exclude_tmpdir_env_var=true " +
        "-c sandbox_workspace_write.exclude_slash_tmp=true",
    );
  });

  it("makes containment override a weaker preconfigured native sandbox", () => {
    expect(
      buildQaCodexAppServerArgs({
        existingArgs:
          "app-server -c sandbox_workspace_write.exclude_slash_tmp=false --listen stdio://",
      }),
    ).toBe(
      "app-server -c sandbox_workspace_write.exclude_slash_tmp=false --listen stdio:// " +
        "-c sandbox_workspace_write.exclude_tmpdir_env_var=true " +
        "-c sandbox_workspace_write.exclude_slash_tmp=true",
    );
  });

  it("owns native provider routing and workspace containment in the QA launcher", () => {
    expect(buildQaCodexAppServerArgs({ providerBaseUrl: "http://127.0.0.1:44080/v1/" })).toBe(
      "app-server -c openai_base_url=http://127.0.0.1:44080/v1 " +
        "-c sandbox_workspace_write.exclude_tmpdir_env_var=true " +
        "-c sandbox_workspace_write.exclude_slash_tmp=true --listen stdio://",
    );
  });

  it("preserves quoted native model-catalog paths", () => {
    expect(
      buildQaCodexAppServerArgs({
        providerBaseUrl: "http://127.0.0.1:44080/v1",
        modelCatalogPath: "/tmp/qa catalog/models.json",
      }),
    ).toContain('-c "model_catalog_json=/tmp/qa catalog/models.json"');
  });

  it("rejects a missing managed provider URL", () => {
    expect(() => buildQaCodexAppServerArgs({ providerBaseUrl: "  " })).toThrow(
      "forced Codex mock QA requires the managed mock provider URL",
    );
  });
});
