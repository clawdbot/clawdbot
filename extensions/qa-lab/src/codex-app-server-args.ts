/** Keeps native Codex workspace containment in every QA-owned runtime. */
export function buildQaCodexAppServerArgs(
  params: {
    providerBaseUrl?: string;
    modelCatalogPath?: string;
    existingArgs?: string;
  } = {},
): string {
  const providerBaseUrl = params.providerBaseUrl?.trim().replace(/\/+$/u, "");
  if (params.providerBaseUrl !== undefined && !providerBaseUrl) {
    throw new Error("forced Codex mock QA requires the managed mock provider URL");
  }
  const existingArgs = params.existingArgs?.trim();
  if (existingArgs && !providerBaseUrl) {
    // Preserve live provider, feature, and transport flags. Native Codex
    // applies repeated overrides in order, so QA containment remains final.
    return [
      existingArgs,
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ].join(" ");
  }
  return [
    "app-server",
    ...(providerBaseUrl ? ["-c", `openai_base_url=${providerBaseUrl}`] : []),
    ...(params.modelCatalogPath
      ? ["-c", JSON.stringify(`model_catalog_json=${params.modelCatalogPath}`)]
      : []),
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "--listen",
    "stdio://",
  ].join(" ");
}
