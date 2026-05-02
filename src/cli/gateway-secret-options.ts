import { readSecretFromFile } from "../acp/secret-file.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

function resolveGatewaySecretOption(params: {
  direct?: unknown;
  file?: unknown;
  directFlag: string;
  fileFlag: string;
  label: string;
}): string | undefined {
  const direct = normalizeOptionalString(params.direct);
  const file = normalizeOptionalString(params.file);
  if (direct && file) {
    throw new Error(`Use either ${params.directFlag} or ${params.fileFlag} for ${params.label}.`);
  }
  if (file) {
    return readSecretFromFile(file, params.label);
  }
  return direct || undefined;
}

function warnGatewaySecretCliFlag(flag: "--token" | "--password"): void {
  defaultRuntime.error(
    `Warning: ${flag} can be exposed via process listings. Prefer ${flag}-file or environment variables.`,
  );
}

export function resolveGatewayAuthOptions(opts: {
  token?: unknown;
  tokenFile?: unknown;
  password?: unknown;
  passwordFile?: unknown;
}): {
  gatewayToken?: string;
  gatewayPassword?: string;
} {
  const gatewayToken = resolveGatewaySecretOption({
    direct: opts.token,
    file: opts.tokenFile,
    directFlag: "--token",
    fileFlag: "--token-file",
    label: "Gateway token",
  });
  const gatewayPassword = resolveGatewaySecretOption({
    direct: opts.password,
    file: opts.passwordFile,
    directFlag: "--password",
    fileFlag: "--password-file",
    label: "Gateway password",
  });
  if (opts.token) {
    warnGatewaySecretCliFlag("--token");
  }
  if (opts.password) {
    warnGatewaySecretCliFlag("--password");
  }
  return { gatewayToken, gatewayPassword };
}
