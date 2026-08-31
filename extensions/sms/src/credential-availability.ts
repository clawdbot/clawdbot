import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";

export function assertSmsCredentialOwnerAvailable(accountId: string): void {
  assertSecretOwnerAvailable("account", `sms:${normalizeAccountId(accountId)}`);
}
