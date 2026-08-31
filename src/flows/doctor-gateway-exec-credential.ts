import type { OpenClawConfig } from "../config/types.openclaw.js";

export async function hasActiveGatewayExecCredential(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targetUrl?: string;
}): Promise<boolean> {
  const [{ resolveSecretInputRef }, { gatewaySecretInputPathCanWin }, secretPaths] =
    await Promise.all([
      import("../config/types.secrets.js"),
      import("../gateway/credentials-secret-inputs.js"),
      import("../gateway/secret-input-paths.js"),
    ]);
  const mode = params.cfg.gateway?.mode === "remote" ? "remote" : "local";
  const hasExecCredential = secretPaths.ALL_GATEWAY_SECRET_INPUT_PATHS.some((path) => {
    if (
      !gatewaySecretInputPathCanWin({
        config: params.cfg,
        env: params.env ?? process.env,
        modeOverride: mode,
        path,
      })
    ) {
      return false;
    }
    const ref = resolveSecretInputRef({
      value: secretPaths.readGatewaySecretInputValue(params.cfg, path),
      defaults: params.cfg.secrets?.defaults,
    }).ref;
    return ref?.source === "exec";
  });
  if (hasExecCredential || !params.cfg.gateway?.remote?.edgeAuth) {
    return hasExecCredential;
  }

  const [{ buildGatewayProbeConnectionDetails }, edgeAuth] = await Promise.all([
    import("../gateway/call.js"),
    import("../gateway/edge-auth.js"),
  ]);
  const targetUrl =
    params.targetUrl ?? (await buildGatewayProbeConnectionDetails({ config: params.cfg })).url;
  const { gatewayEdgeAuthValueForTarget, normalizeEdgeAuthHeadersConfig } = edgeAuth;
  const headers = normalizeEdgeAuthHeadersConfig(
    gatewayEdgeAuthValueForTarget({ config: params.cfg, targetUrl }),
  );
  return Object.values(headers ?? {}).some(
    (value) =>
      resolveSecretInputRef({ value, defaults: params.cfg.secrets?.defaults }).ref?.source ===
      "exec",
  );
}
