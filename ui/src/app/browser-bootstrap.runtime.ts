import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { readResponseTextWithLimit } from "../lib/response-body.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";

const BROWSER_BOOTSTRAP_PATH = "/.well-known/openclaw/browser-bootstrap";
// A host handoff may verify identity and mint a credential in separate bounded operations.
const BROWSER_BOOTSTRAP_TIMEOUT_MS = 45_000;

/** Recover initial browser authentication through an identity-aware same-origin host. */
export function startBrowserBootstrapRecovery(
  gateway: ApplicationGateway,
  basePath: string,
): () => void {
  const location = globalThis.location;
  const revision = gateway.connectionRevision;
  const connection = gateway.connection;
  if (
    location?.protocol !== "https:" ||
    gatewayCredentialScope(connection.gatewayUrl) !==
      gatewayCredentialScope(`wss://${location.host}${basePath}`) ||
    connection.token ||
    connection.password ||
    connection.bootstrapToken
  ) {
    return () => {};
  }
  const gatewayUrl = new URL(connection.gatewayUrl);
  if (gatewayUrl.username || gatewayUrl.password || gatewayUrl.hash) {
    return () => {};
  }

  const abort = new AbortController();
  let attempted = false;
  let initialClient = gateway.snapshot.client;
  const recover = async () => {
    const timeout = globalThis.setTimeout(() => abort.abort(), BROWSER_BOOTSTRAP_TIMEOUT_MS);
    try {
      const response = await fetch(`${basePath}${BROWSER_BOOTSTRAP_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
      });
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!response.ok || contentType !== "application/json") {
        void response.body?.cancel().catch(() => undefined);
        return;
      }
      const body = await readResponseTextWithLimit(response, {
        maxBytes: 8192,
        tooLargeMessage: "Browser bootstrap response exceeded its limit",
      });
      const bootstrap = asOptionalRecord(JSON.parse(body));
      if (
        !bootstrap ||
        Object.keys(bootstrap).length !== 2 ||
        typeof bootstrap.bootstrapToken !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/u.test(bootstrap.bootstrapToken) ||
        bootstrap.bootstrapProfile !== "owner"
      ) {
        return;
      }
      // A user edit, stop, or replacement connection revokes this pending handoff.
      // Never send the host's credential to a subsequently selected Gateway.
      if (
        !abort.signal.aborted &&
        gateway.connectionRevision === revision &&
        gateway.snapshot.client === initialClient &&
        gateway.snapshot.phase === "stopped"
      ) {
        gateway.connect({
          bootstrapToken: bootstrap.bootstrapToken,
          bootstrapProfile: bootstrap.bootstrapProfile,
        });
      }
    } catch {
      // Ordinary Gateways have no issuer here. Keep the existing actionable auth error.
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };
  const onSnapshot = (snapshot: ApplicationGatewaySnapshot) => {
    initialClient ??= snapshot.client;
    if (
      gateway.connectionRevision !== revision ||
      snapshot.client !== initialClient ||
      snapshot.phase === "connected"
    ) {
      abort.abort();
    }
    if (
      attempted ||
      abort.signal.aborted ||
      !snapshot.client ||
      snapshot.phase !== "stopped" ||
      (snapshot.lastErrorCode !== ConnectErrorDetailCodes.AUTH_TOKEN_MISSING &&
        snapshot.lastErrorCode !== ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING)
    ) {
      return;
    }
    attempted = true;
    void recover();
  };
  const unsubscribe = gateway.subscribe(onSnapshot);
  onSnapshot(gateway.snapshot);
  return () => {
    abort.abort();
    unsubscribe();
  };
}
