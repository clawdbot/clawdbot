import { readFileSync } from "node:fs";
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
    const filePassword = readFileSync(params.apiPasswordFile, "utf-8").trim();
    return filePassword ? { apiUser, apiPassword: filePassword } : undefined;
  } catch {
    return undefined;
  }
}
