import type { IncomingMessage, ServerResponse } from "node:http";
import {
  completeGatewayEnterpriseIdentityAuthorizationCallback,
  type GatewayEnterpriseIdentityAuthorizationResult,
} from "./memory-enterprise-oidc-transaction.js";

export const MEMORY_ENTERPRISE_OIDC_CALLBACK_PATH = "/memory/oidc/callback";

const MAX_CODE_LENGTH = 8_192;

type CompleteAuthorization = (params: {
  state: string;
  code: string;
}) => Promise<GatewayEnterpriseIdentityAuthorizationResult>;

function hasOneBoundedParameter(
  params: URLSearchParams,
  name: string,
  maxLength: number,
): string | undefined {
  const values = params.getAll(name);
  if (values.length !== 1) {
    return undefined;
  }
  const value = values[0]!;
  return value.length > 0 && value.length <= maxLength ? value : undefined;
}

function hasOneTransactionState(params: URLSearchParams): string | undefined {
  const values = params.getAll("state");
  if (values.length !== 1) {
    return undefined;
  }
  // Transactions use 32 random bytes encoded as unpadded base64url. Keeping
  // this exact wire shape prevents the public route from becoming an oracle
  // over arbitrary identifiers while preserving a fixed receipt capability.
  return /^[A-Za-z0-9_-]{43}$/u.test(values[0]!) ? values[0] : undefined;
}

function writeCallbackPage(res: ServerResponse, statusCode: number, message: string): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenClaw</title></head><body><p>${message}</p></body></html>`;
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.end(body);
}

/**
 * Handles the public redirect endpoint for a receipt-bound OIDC login. It does
 * not authenticate the browser: the opaque, one-use state receipt is the sole
 * capability and completion returns no provider, account, or profile details.
 */
export async function handleMemoryEnterpriseOidcCallbackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { complete?: CompleteAuthorization } = {},
): Promise<boolean> {
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  if (callbackUrl.pathname !== MEMORY_ENTERPRISE_OIDC_CALLBACK_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    res.setHeader("Allow", "GET");
    writeCallbackPage(res, 405, "This sign-in callback only accepts GET requests.");
    return true;
  }

  const state = hasOneTransactionState(callbackUrl.searchParams);
  const hasCodeParameter = callbackUrl.searchParams.has("code");
  const code = hasOneBoundedParameter(callbackUrl.searchParams, "code", MAX_CODE_LENGTH);
  if (!state || (hasCodeParameter && !code)) {
    writeCallbackPage(
      res,
      400,
      "Sign-in could not be completed. Return to OpenClaw and try again.",
    );
    return true;
  }
  if (!code) {
    // A provider-denied redirect can contain an otherwise-valid receipt but no
    // code. Consume it so that an interrupted login cannot be resumed later.
    if (state) {
      await (options.complete ?? completeGatewayEnterpriseIdentityAuthorizationCallback)({
        state,
        code: "",
      });
    }
    writeCallbackPage(
      res,
      400,
      "Sign-in could not be completed. Return to OpenClaw and try again.",
    );
    return true;
  }

  const result = await (options.complete ?? completeGatewayEnterpriseIdentityAuthorizationCallback)(
    {
      state,
      code,
    },
  );
  if (result.kind !== "linked") {
    writeCallbackPage(
      res,
      400,
      "Sign-in could not be completed. Return to OpenClaw and try again.",
    );
    return true;
  }
  writeCallbackPage(res, 200, "Sign-in completed. You can return to OpenClaw.");
  return true;
}
