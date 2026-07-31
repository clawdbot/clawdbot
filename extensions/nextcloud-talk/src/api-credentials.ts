// Nextcloud Talk plugin module implements api credentials behavior.
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { normalizeResolvedSecretInputString } from "./secret-input.js";

export type NextcloudTalkCredentialUnavailableDiagnostic = Extract<
  ReturnType<typeof tryReadSecretFileSync>,
  { status: "configured_unavailable" }
>["diagnostic"];
type CredentialResult<T> =
  | { status: "available"; value: T }
  | {
      status: "configured_unavailable";
      diagnostic: NextcloudTalkCredentialUnavailableDiagnostic;
    }
  | { status: "missing" };

export function resolveNextcloudTalkApiCredentialsResult(params: {
  apiUser?: string;
  apiPassword?: unknown;
  apiPasswordFile?: string;
  configPath?: string;
}): CredentialResult<{ apiUser: string; apiPassword: string }> {
  const apiUser = params.apiUser?.trim();
  if (!apiUser) {
    return { status: "missing" };
  }

  const inlinePassword = normalizeResolvedSecretInputString({
    value: params.apiPassword,
    path: "channels.nextcloud-talk.apiPassword",
  });
  if (inlinePassword) {
    return { status: "available", value: { apiUser, apiPassword: inlinePassword } };
  }

  if (!params.apiPasswordFile?.trim()) {
    return { status: "missing" };
  }
  const result = tryReadSecretFileSync(
    params.apiPasswordFile,
    "Nextcloud Talk API password",
    // Existing apiPasswordFile paths may be symlinks or hardlinks. Keep that
    // contract while gaining the shared credential size and pinned-read checks.
    { rejectHardlinks: false },
    { configPath: params.configPath ?? "channels.nextcloud-talk.apiPasswordFile" },
  );
  if (result.status === "available") {
    return result.value
      ? { status: "available", value: { apiUser, apiPassword: result.value } }
      : { status: "missing" };
  }
  return result;
}

export function resolveNextcloudTalkApiCredentials(params: {
  apiUser?: string;
  apiPassword?: unknown;
  apiPasswordFile?: string;
}): { apiUser: string; apiPassword: string } | undefined {
  const result = resolveNextcloudTalkApiCredentialsResult(params);
  return result.status === "available" ? result.value : undefined;
}
