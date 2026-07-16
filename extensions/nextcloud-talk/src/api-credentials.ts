// Nextcloud Talk plugin module implements api credentials behavior.
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { normalizeResolvedSecretInputString } from "./secret-input.js";

export function resolveNextcloudTalkApiCredentials(params: {
  apiUser?: string;
  apiPassword?: unknown;
  apiPasswordFile?: string;
}): { apiUser: string; apiPassword: string } | undefined {
  const apiUser = params.apiUser?.trim();
  if (!apiUser) {
    return undefined;
  }

  const inlinePassword = normalizeResolvedSecretInputString({
    value: params.apiPassword,
    path: "channels.nextcloud-talk.apiPassword",
  });
  if (inlinePassword) {
    return { apiUser, apiPassword: inlinePassword };
  }

  if (!params.apiPasswordFile) {
    return undefined;
  }
  try {
    const fileValue = tryReadSecretFileSync(
      params.apiPasswordFile,
      "Nextcloud Talk API password",
      // Existing apiPasswordFile paths may be symlinks or hardlinks. Keep that
      // contract while gaining the shared credential size and pinned-read checks.
      { rejectHardlinks: false },
    );
    return fileValue ? { apiUser, apiPassword: fileValue } : undefined;
  } catch {
    return undefined;
  }
}
