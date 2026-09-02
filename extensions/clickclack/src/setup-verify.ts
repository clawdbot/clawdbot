// ClickClack plugin module implements shared setup connection verification.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/setup";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { resolveWorkspaceId } from "./resolve.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

type ClickClackSetupConnectionResult =
  | { status: "connected"; handle: string; workspaceName: string }
  | { status: "invalid-token" }
  | { status: "workspace-not-found"; workspace: string }
  | { status: "failed"; error: string }
  | { status: "skipped-env-token" }
  | { status: "skipped-unconfigured" };

type ClickClackGatewayStatus = "running" | "not-running" | "unavailable";

const GATEWAY_RUNNING_MESSAGE = "OpenClaw is running — ClickClack will connect automatically.";
const GATEWAY_NOT_RUNNING_MESSAGE = "Start OpenClaw to connect: openclaw gateway";
const GATEWAY_UNKNOWN_MESSAGE =
  "If OpenClaw is running it connects automatically; otherwise start it with: openclaw gateway";

function isHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === status
  );
}

function isWorkspaceNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("ClickClack workspace not found:");
}

function usesUnavailableImplicitEnvToken(
  account: ResolvedClickClackAccount,
  tokenOverride: string,
): boolean {
  return (
    account.accountId === DEFAULT_ACCOUNT_ID &&
    Boolean(account.baseUrl && account.workspace) &&
    !tokenOverride &&
    !account.token &&
    !hasConfiguredSecretInput(account.config.token) &&
    !account.config.tokenFile?.trim()
  );
}

export async function checkClickClackSetupConnection(params: {
  cfg: CoreConfig;
  accountId?: string;
  token?: string;
}): Promise<ClickClackSetupConnectionResult> {
  let workspaceInput = "";
  try {
    const account = resolveClickClackAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    workspaceInput = account.workspace;
    const token = params.token?.trim() || account.token;
    if (usesUnavailableImplicitEnvToken(account, token)) {
      return { status: "skipped-env-token" };
    }
    if (!account.baseUrl || !account.workspace || !token) {
      return { status: "skipped-unconfigured" };
    }

    const client = createClickClackClient({
      baseUrl: account.apiEndpoint,
      token,
    });
    const me = await client.me();
    const workspaceId = await resolveWorkspaceId(client, account.workspace);
    const workspaces = await client.workspaces();
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error(`ClickClack workspace not found: ${account.workspace}`);
    }
    return {
      status: "connected",
      handle: me.handle,
      workspaceName: workspace.name,
    };
  } catch (error) {
    if (isHttpStatus(error, 401)) {
      return { status: "invalid-token" };
    }
    if (isWorkspaceNotFound(error)) {
      return {
        status: "workspace-not-found",
        workspace: workspaceInput,
      };
    }
    return {
      status: "failed",
      error: formatErrorMessage(error),
    };
  }
}

function isGatewayNotRunningError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "kind" in error &&
    "code" in error &&
    (error as { name?: unknown }).name === "GatewayTransportError" &&
    (error as { kind?: unknown }).kind === "closed" &&
    (error as { code?: unknown }).code === 1006
  ) {
    return true;
  }
  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("econnrefused") || message.includes("connection refused");
}

async function probeClickClackGatewayStatus(): Promise<ClickClackGatewayStatus> {
  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    await callGatewayFromCli("health", { timeout: "1000", json: true }, undefined, {
      expectFinal: false,
      progress: false,
    });
    return "running";
  } catch (error) {
    return isGatewayNotRunningError(error) ? "not-running" : "unavailable";
  }
}

function formatClickClackConnectionLog(
  result: ClickClackSetupConnectionResult,
): string | undefined {
  switch (result.status) {
    case "connected":
      return `Connected as @${result.handle} — workspace ${result.workspaceName} resolved.`;
    case "invalid-token":
      return "ClickClack rejected the bot token (401). Copy a current token and rerun setup.";
    case "workspace-not-found":
      return `Workspace "${result.workspace}" was not found. Check the id, slug, or name, list available workspaces, and rerun setup.`;
    case "failed":
      return `Connection check failed: ${result.error}. Setup was saved; fix the connection and rerun setup.`;
    case "skipped-env-token":
      return "Token comes from CLICKCLACK_BOT_TOKEN; verification skipped.";
    case "skipped-unconfigured":
      return undefined;
  }
  return undefined;
}

function formatClickClackGatewayLog(status: ClickClackGatewayStatus): string {
  switch (status) {
    case "running":
      return GATEWAY_RUNNING_MESSAGE;
    case "not-running":
      return GATEWAY_NOT_RUNNING_MESSAGE;
    case "unavailable":
      return GATEWAY_UNKNOWN_MESSAGE;
  }
  return GATEWAY_UNKNOWN_MESSAGE;
}

export async function verifyClickClackAccountAfterSetup(params: {
  cfg: CoreConfig;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  try {
    const result = await checkClickClackSetupConnection({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    const message = formatClickClackConnectionLog(result);
    if (message) {
      params.runtime.log(message);
    }
  } catch (error) {
    params.runtime.log(
      `Connection check failed: ${formatErrorMessage(error)}. Setup was saved; fix the connection and rerun setup.`,
    );
  }

  try {
    const status = await probeClickClackGatewayStatus();
    params.runtime.log(formatClickClackGatewayLog(status));
  } catch {
    params.runtime.log(GATEWAY_UNKNOWN_MESSAGE);
  }
}
