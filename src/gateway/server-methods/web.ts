import { loadConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { startWebLoginWithQr, waitForWebLogin } from "../../web/login-qr.js";
import { logoutWeb } from "../../web/session.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": async ({ params, respond, context }) => {
    if (!validateWebLoginStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const accountId =
        typeof (params as { accountId?: unknown }).accountId === "string"
          ? (params as { accountId?: string }).accountId
          : undefined;
      await context.stopWhatsAppProvider(accountId);
      const result = await startWebLoginWithQr({
        force: Boolean((params as { force?: boolean }).force),
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        verbose: Boolean((params as { verbose?: boolean }).verbose),
        accountId,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "web.login.wait": async ({ params, respond, context }) => {
    if (!validateWebLoginWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const accountId =
        typeof (params as { accountId?: unknown }).accountId === "string"
          ? (params as { accountId?: string }).accountId
          : undefined;
      const result = await waitForWebLogin({
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        accountId,
      });
      if (result.connected) {
        await context.startWhatsAppProvider(accountId);
      }
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "web.logout": async ({ params, respond, context }) => {
    try {
      const rawAccountId =
        params && typeof params === "object" && "accountId" in params
          ? (params as { accountId?: unknown }).accountId
          : undefined;
      const accountId =
        typeof rawAccountId === "string" ? rawAccountId.trim() : "";
      const cfg = loadConfig();
      const account = resolveWhatsAppAccount({
        cfg,
        accountId: accountId || undefined,
      });
      await context.stopWhatsAppProvider(account.accountId);
      const cleared = await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime: defaultRuntime,
      });
      context.markProviderLoggedOut("whatsapp", cleared, account.accountId);
      respond(true, { cleared }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
};
