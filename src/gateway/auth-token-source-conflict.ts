import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const GATEWAY_ENV_TOKEN = "OPENCLAW_GATEWAY_TOKEN";
const GATEWAY_SERVICE_KIND = "gateway";

export type GatewayAuthTokenSourceConflict = {
  checkId: "gateway.env_token_overrides_config";
  title: string;
  detail: string;
  remediation: string;
  warningLines: string[];
  diagnostic: string;
};

export function resolveGatewayAuthTokenSourceConflict(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): GatewayAuthTokenSourceConflict | null {
  const envToken = normalizeOptionalString(params.env.OPENCLAW_GATEWAY_TOKEN);
  if (!envToken) {
    return null;
  }

  if (params.env.OPENCLAW_SERVICE_KIND?.trim() === GATEWAY_SERVICE_KIND) {
    return null;
  }

  if (params.cfg.gateway?.mode === "remote") {
    return null;
  }

  const authMode = params.cfg.gateway?.auth?.mode;
  if (authMode === "password" || authMode === "none" || authMode === "trusted-proxy") {
    return null;
  }

  const tokenInput = params.cfg.gateway?.auth?.token;
  const { ref } = resolveSecretInputRef({
    value: tokenInput,
    defaults: params.cfg.secrets?.defaults,
  });
  if (ref?.source === "env" && ref.id === GATEWAY_ENV_TOKEN) {
    return null;
  }

  const configToken = ref ? undefined : normalizeSecretInputString(tokenInput);
  if (!ref && !configToken) {
    return null;
  }
  if (configToken === envToken) {
    return null;
  }

  const title = `${GATEWAY_ENV_TOKEN} conflicts with gateway.auth.token`;
  const detail =
    `${GATEWAY_ENV_TOKEN} is set while gateway.auth.token uses a different configured source. ` +
    "Direct local Gateway clients commonly prefer the env token, while the managed gateway service " +
    "prefers gateway.auth.token. If the values differ, CLI/RPC calls can fail to authenticate " +
    "with the running gateway.";
  const remediation =
    `Remove ${GATEWAY_ENV_TOKEN} from the shell, ~/.openclaw/.env, or launchctl env if gateway.auth.token is intended, ` +
    `or point gateway.auth.token at \${${GATEWAY_ENV_TOKEN}} if the env var should be canonical.`;

  return {
    checkId: "gateway.env_token_overrides_config",
    title,
    detail,
    remediation,
    warningLines: [`- WARNING: ${title}.`, `  ${detail}`, `  Fix: ${remediation}`],
    diagnostic: `${title}: ${remediation}`,
  };
}
