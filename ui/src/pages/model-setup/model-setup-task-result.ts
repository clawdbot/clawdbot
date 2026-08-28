import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupActivateResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

export type ModelSetupTaskResult<T> =
  | { client: GatewayBrowserClient; value: T }
  | { client: GatewayBrowserClient; error: unknown };

export type ModelSetupActivationTaskResult = {
  result: SystemAgentSetupActivateResult;
  refreshError: string | null;
};

export function formatModelSetupError(error: unknown): string {
  return formatUiError(error, t("modelSetup.errors.requestFailed"));
}

export async function captureModelSetupResult<T>(
  client: GatewayBrowserClient,
  load: () => Promise<T>,
): Promise<ModelSetupTaskResult<T>> {
  try {
    return { client, value: await load() };
  } catch (error) {
    return { client, error };
  }
}
