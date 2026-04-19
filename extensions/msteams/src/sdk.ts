import * as fs from "node:fs";
// IHttpServerAdapter is re-exported via the public barrel (`export * from './http'`)
// but tsgo cannot resolve the chain. Use the dist subpath directly (type-only import).
import type { IHttpServerAdapter } from "@microsoft/teams.apps/dist/http/index.js";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";
import { buildUserAgent } from "./user-agent.js";

/**
 * Resolved Teams SDK modules loaded lazily to avoid importing when the
 * provider is disabled.
 */
export type MSTeamsTeamsSdk = {
  App: typeof import("@microsoft/teams.apps").App;
  Client: typeof import("@microsoft/teams.api").Client;
};

/**
 * A Teams SDK App instance used for token management and proactive messaging.
 */
export type MSTeamsApp = InstanceType<MSTeamsTeamsSdk["App"]>;

/**
 * Token provider compatible with the existing codebase, wrapping the Teams
 * SDK App's token methods.
 */
export type MSTeamsTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

type MSTeamsBotIdentity = {
  id?: string;
  name?: string;
};

type MSTeamsSendContext = {
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
  updateActivity: (activityUpdate: object) => Promise<{ id?: string } | void>;
  deleteActivity: (activityId: string) => Promise<void>;
};

type MSTeamsProcessContext = MSTeamsSendContext & {
  activity: Record<string, unknown> | undefined;
  sendActivities: (
    activities: Array<{ type: string } & Record<string, unknown>>,
  ) => Promise<unknown[]>;
};

type AzureAccessToken = {
  token?: string;
} | null;

type AzureTokenCredential = {
  getToken: (scope: string | string[]) => Promise<AzureAccessToken>;
};

type AzureIdentityModule = {
  ClientCertificateCredential: new (
    tenantId: string,
    clientId: string,
    options: { certificate: string },
  ) => AzureTokenCredential;
  ManagedIdentityCredential: new (clientId?: string) => AzureTokenCredential;
};

const AZURE_IDENTITY_MODULE = "@azure/identity";

let azureIdentityModulePromise: Promise<AzureIdentityModule> | null = null;

async function loadAzureIdentity(): Promise<AzureIdentityModule> {
  azureIdentityModulePromise ??= import(AZURE_IDENTITY_MODULE) as Promise<AzureIdentityModule>;
  return azureIdentityModulePromise;
}

let msTeamsSdkPromise: Promise<MSTeamsTeamsSdk> | null = null;

export async function loadMSTeamsSdk(): Promise<MSTeamsTeamsSdk> {
  msTeamsSdkPromise ??= Promise.all([
    import("@microsoft/teams.apps"),
    import("@microsoft/teams.api"),
  ]).then(([appsModule, apiModule]) => ({
    App: appsModule.App,
    Client: apiModule.Client,
  }));
  return msTeamsSdkPromise;
}

/**
 * Create a no-op HTTP server adapter that satisfies the Teams SDK's
 * IHttpServerAdapter interface without spinning up an Express server.
 *
 * OpenClaw manages its own Express server for the Teams webhook endpoint, so
 * the SDK's built-in HTTP server is unnecessary.  Passing this adapter via the
 * `httpServerAdapter` option prevents the SDK from creating the default
 * HttpPlugin (which uses the deprecated `plugins` array and registers an
 * Express middleware with the pattern `/api*` — invalid in Express 5).
 *
 * See: https://github.com/openclaw/openclaw/issues/55161
 * See: https://github.com/openclaw/openclaw/issues/60732
 */
function createNoOpHttpServerAdapter(): IHttpServerAdapter {
  return {
    registerRoute() {},
  };
}

/**
 * Create a Teams SDK App instance from credentials. The App manages token
 * acquisition, JWT validation, and the HTTP server lifecycle.
 *
 * This replaces the previous CloudAdapter + MsalTokenProvider + authorizeJWT
 * from @microsoft/agents-hosting.
 */
export async function createMSTeamsApp(
  creds: MSTeamsCredentials,
  sdk: MSTeamsTeamsSdk,
): Promise<MSTeamsApp> {
  if (creds.type === "federated") {
    return createFederatedApp(creds, sdk);
  }
  return new sdk.App({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
    httpServerAdapter: createNoOpHttpServerAdapter(),
  } as ConstructorParameters<MSTeamsTeamsSdk["App"]>[0]);
}

function createFederatedApp(creds: MSTeamsFederatedCredentials, sdk: MSTeamsTeamsSdk): MSTeamsApp {
  if (creds.useManagedIdentity) {
    return createManagedIdentityApp(creds, sdk);
  }

  // Certificate-based auth
  if (!creds.certificatePath) {
    throw new Error("Federated credentials require either a certificate path or managed identity.");
  }

  let privateKey: string;
  try {
    privateKey = fs.readFileSync(creds.certificatePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read certificate file at '${creds.certificatePath}': ${msg}`, {
      cause: err,
    });
  }

  return createCertificateApp(creds, privateKey, sdk);
}

function createCertificateApp(
  creds: MSTeamsFederatedCredentials,
  privateKey: string,
  sdk: MSTeamsTeamsSdk,
): MSTeamsApp {
  // Lazily create and cache the credential so the token cache is reused.
  let credentialPromise: Promise<AzureTokenCredential> | null = null;

  const getCredential = async () => {
    if (!credentialPromise) {
      credentialPromise = loadAzureIdentity().then(
        (az) =>
          new az.ClientCertificateCredential(creds.tenantId, creds.appId, {
            certificate: privateKey,
          }),
      );
    }
    return credentialPromise;
  };

  const tokenProvider = async (scope: string | string[]): Promise<string> => {
    const credential = await getCredential();
    const token = await credential.getToken(scope);

    if (!token?.token) {
      throw new Error("Failed to acquire token via certificate credential.");
    }

    return token.token;
  };

  return new sdk.App({
    clientId: creds.appId,
    tenantId: creds.tenantId,
    token: tokenProvider,
    httpServerAdapter: createNoOpHttpServerAdapter(),
  } as unknown as ConstructorParameters<MSTeamsTeamsSdk["App"]>[0]);
}

function createManagedIdentityApp(
  creds: MSTeamsFederatedCredentials,
  sdk: MSTeamsTeamsSdk,
): MSTeamsApp {
  // Lazily create and cache the credential instance so the token cache is
  // reused across calls instead of hitting IMDS/AAD on every message.
  let credentialPromise: Promise<AzureTokenCredential> | null = null;

  const getCredential = async () => {
    if (!credentialPromise) {
      credentialPromise = loadAzureIdentity().then((az) =>
        creds.managedIdentityClientId
          ? new az.ManagedIdentityCredential(creds.managedIdentityClientId)
          : new az.ManagedIdentityCredential(),
      );
    }
    return credentialPromise;
  };

  const tokenProvider = async (scope: string | string[]): Promise<string> => {
    const credential = await getCredential();
    const token = await credential.getToken(scope);

    if (!token?.token) {
      throw new Error("Failed to acquire token via managed identity.");
    }

    return token.token;
  };

  return new sdk.App({
    clientId: creds.appId,
    tenantId: creds.tenantId,
    token: tokenProvider,
    httpServerAdapter: createNoOpHttpServerAdapter(),
  } as unknown as ConstructorParameters<MSTeamsTeamsSdk["App"]>[0]);
}

/**
 * Build a token provider that uses the Teams SDK App for token acquisition.
 */
export function createMSTeamsTokenProvider(app: MSTeamsApp): MSTeamsTokenProvider {
  return {
    async getAccessToken(scope: string): Promise<string> {
      if (scope.includes("graph.microsoft.com")) {
        const token = await (
          app as unknown as { getAppGraphToken(): Promise<{ toString(): string } | null> }
        ).getAppGraphToken();
        return token ? String(token) : "";
      }
      const token = await (
        app as unknown as { getBotToken(): Promise<{ toString(): string } | null> }
      ).getBotToken();
      return token ? String(token) : "";
    },
  };
}

function createBotTokenGetter(app: MSTeamsApp): () => Promise<string | undefined> {
  return async () => {
    const token = await (
      app as unknown as { getBotToken(): Promise<{ toString(): string } | null> }
    ).getBotToken();
    return token ? String(token) : undefined;
  };
}

function createApiClient(
  sdk: MSTeamsTeamsSdk,
  serviceUrl: string,
  getToken: () => Promise<string | undefined>,
) {
  return new sdk.Client(serviceUrl, {
    token: async () => (await getToken()) || undefined,
    headers: { "User-Agent": buildUserAgent() },
  } as Record<string, unknown>);
}

function normalizeOutboundActivity(textOrActivity: string | object): Record<string, unknown> {
  return typeof textOrActivity === "string"
    ? ({ type: "message", text: textOrActivity } as Record<string, unknown>)
    : (textOrActivity as Record<string, unknown>);
}

function createSendContext(params: {
  sdk: MSTeamsTeamsSdk;
  serviceUrl?: string;
  conversationId?: string;
  conversationType?: string;
  bot?: MSTeamsBotIdentity;
  replyToActivityId?: string;
  getToken: () => Promise<string | undefined>;
  treatInvokeResponseAsNoop?: boolean;
  /**
   * Azure AD tenant ID for the target conversation. Bot Framework requires this
   * on outbound proactive activities so the connector can route them to the
   * correct tenant. Missing `tenantId` causes HTTP 403 on proactive sends.
   */
  tenantId?: string;
  /** Target user's Teams user ID (e.g. `29:xxx`); included on the recipient field for routing. */
  recipientId?: string;
  /** Target user's Azure AD object ID; included as the recipient on personal DMs. */
  recipientAadObjectId?: string;
}): MSTeamsSendContext {
  const apiClient =
    params.serviceUrl && params.conversationId
      ? createApiClient(params.sdk, params.serviceUrl, params.getToken)
      : undefined;

  return {
    async sendActivity(textOrActivity: string | object): Promise<unknown> {
      const msg = normalizeOutboundActivity(textOrActivity);
      if (params.treatInvokeResponseAsNoop && msg.type === "invokeResponse") {
        return { id: "invokeResponse" };
      }
      if (!apiClient || !params.conversationId) {
        return { id: "unknown" };
      }

      // Merge caller-provided channelData with the tenant metadata so Bot
      // Framework receives `channelData.tenant.id` (the canonical source it
      // uses to route proactive sends). Preserve any existing channelData
      // fields the caller set (e.g. feedbackLoopEnabled).
      const existingChannelData =
        msg.channelData && typeof msg.channelData === "object"
          ? (msg.channelData as Record<string, unknown>)
          : undefined;
      const channelData = params.tenantId
        ? {
            ...existingChannelData,
            tenant: { id: params.tenantId },
          }
        : existingChannelData;

      return await apiClient.conversations.activities(params.conversationId).create({
        type: "message",
        ...msg,
        ...(channelData ? { channelData } : {}),
        from: params.bot?.id
          ? { id: params.bot.id, name: params.bot.name ?? "", role: "bot" }
          : undefined,
        conversation: {
          id: params.conversationId,
          conversationType: params.conversationType ?? "personal",
          ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        },
        ...(params.recipientId || params.recipientAadObjectId
          ? {
              recipient: {
                ...(params.recipientId ? { id: params.recipientId } : {}),
                ...(params.recipientAadObjectId
                  ? { aadObjectId: params.recipientAadObjectId }
                  : {}),
              },
            }
          : {}),
        ...(params.replyToActivityId && !msg.replyToId
          ? { replyToId: params.replyToActivityId }
          : {}),
      } as Parameters<
        typeof apiClient.conversations.activities extends (id: string) => {
          create: (a: infer _T) => unknown;
        }
          ? never
          : never
      >[0]);
    },

    async updateActivity(activityUpdate: object): Promise<{ id?: string } | void> {
      const nextActivity = activityUpdate as { id?: string } & Record<string, unknown>;
      const activityId = nextActivity.id;
      if (!activityId) {
        throw new Error("updateActivity requires an activity id");
      }
      if (!params.serviceUrl || !params.conversationId) {
        return { id: "unknown" };
      }
      return await updateActivityViaRest({
        serviceUrl: params.serviceUrl,
        conversationId: params.conversationId,
        activityId,
        activity: nextActivity,
        token: await params.getToken(),
      });
    },

    async deleteActivity(activityId: string): Promise<void> {
      if (!activityId) {
        throw new Error("deleteActivity requires an activity id");
      }
      if (!params.serviceUrl || !params.conversationId) {
        return;
      }
      await deleteActivityViaRest({
        serviceUrl: params.serviceUrl,
        conversationId: params.conversationId,
        activityId,
        token: await params.getToken(),
      });
    },
  };
}

function createProcessContext(params: {
  sdk: MSTeamsTeamsSdk;
  activity: Record<string, unknown> | undefined;
  getToken: () => Promise<string | undefined>;
}): MSTeamsProcessContext {
  const serviceUrl = params.activity?.serviceUrl as string | undefined;
  const conversationId = (params.activity?.conversation as Record<string, unknown>)?.id as
    | string
    | undefined;
  const conversationType = (params.activity?.conversation as Record<string, unknown>)
    ?.conversationType as string | undefined;
  const replyToActivityId = params.activity?.id as string | undefined;
  const bot: MSTeamsBotIdentity | undefined =
    params.activity?.recipient && typeof params.activity.recipient === "object"
      ? {
          id: (params.activity.recipient as Record<string, unknown>).id as string | undefined,
          name: (params.activity.recipient as Record<string, unknown>).name as string | undefined,
        }
      : undefined;
  const sendContext = createSendContext({
    sdk: params.sdk,
    serviceUrl,
    conversationId,
    conversationType,
    bot,
    replyToActivityId,
    getToken: params.getToken,
    treatInvokeResponseAsNoop: true,
  });

  return {
    activity: params.activity,
    ...sendContext,
    async sendActivities(activities: Array<{ type: string } & Record<string, unknown>>) {
      const results = [];
      for (const activity of activities) {
        results.push(await sendContext.sendActivity(activity));
      }
      return results;
    },
  };
}

/**
 * Update an existing activity via the Bot Framework REST API.
 * PUT /v3/conversations/{conversationId}/activities/{activityId}
 */
async function updateActivityViaRest(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  activity: Record<string, unknown>;
  token?: string;
}): Promise<{ id?: string }> {
  const { serviceUrl, conversationId, activityId, activity, token } = params;
  const baseUrl = serviceUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": buildUserAgent(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const currentFetch = globalThis.fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
    init: {
      method: "PUT",
      headers,
      body: JSON.stringify({
        type: "message",
        ...activity,
        id: activityId,
      }),
    },
    auditContext: "msteams-update-activity",
  });

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw Object.assign(new Error(`updateActivity failed: HTTP ${response.status} ${body}`), {
        statusCode: response.status,
      });
    }

    return await response.json().catch(() => ({ id: activityId }));
  } finally {
    await release();
  }
}

/**
 * Delete an existing activity via the Bot Framework REST API.
 * DELETE /v3/conversations/{conversationId}/activities/{activityId}
 */
async function deleteActivityViaRest(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  token?: string;
}): Promise<void> {
  const { serviceUrl, conversationId, activityId, token } = params;
  const baseUrl = serviceUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

  const headers: Record<string, string> = {
    "User-Agent": buildUserAgent(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const currentFetch = globalThis.fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
    init: {
      method: "DELETE",
      headers,
    },
    auditContext: "msteams-delete-activity",
  });

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw Object.assign(new Error(`deleteActivity failed: HTTP ${response.status} ${body}`), {
        statusCode: response.status,
      });
    }
  } finally {
    await release();
  }
}

/**
 * Build a CloudAdapter-compatible adapter using the Teams SDK REST client.
 *
 * This replaces the previous CloudAdapter from @microsoft/agents-hosting.
 * For incoming requests: the App's HTTP server handles JWT validation.
 * For proactive sends: uses the Bot Framework REST API via
 * @microsoft/teams.api Client.
 */
export function createMSTeamsAdapter(app: MSTeamsApp, sdk: MSTeamsTeamsSdk): MSTeamsAdapter {
  return {
    async continueConversation(_appId, reference, logic) {
      const serviceUrl = reference.serviceUrl;
      if (!serviceUrl) {
        throw new Error("Missing serviceUrl in conversation reference");
      }

      const conversationId = reference.conversation?.id;
      if (!conversationId) {
        throw new Error("Missing conversation.id in conversation reference");
      }

      // Bot Framework requires `tenantId` on proactive sends so the connector
      // can route them to the correct Azure AD tenant. Without it, requests
      // fail with HTTP 403. Prefer the top-level `reference.tenantId` (captured
      // from `activity.channelData.tenant.id` at inbound time) and fall back
      // to `conversation.tenantId` for older stored references.
      const tenantId = reference.tenantId ?? reference.conversation?.tenantId;
      const recipientAadObjectId = reference.aadObjectId ?? reference.user?.aadObjectId;

      const recipientId = reference.user?.id;

      const sendContext = createSendContext({
        sdk,
        serviceUrl,
        conversationId,
        conversationType: reference.conversation?.conversationType,
        bot: reference.agent ?? undefined,
        getToken: createBotTokenGetter(app),
        tenantId,
        recipientId,
        recipientAadObjectId,
      });

      await logic(sendContext);
    },

    async process(req, res, logic) {
      const request = req as { body?: Record<string, unknown> };
      const response = res as {
        status: (code: number) => { send: (body?: unknown) => void };
      };

      const activity = request.body;
      const isInvoke = (activity as Record<string, unknown>)?.type === "invoke";

      try {
        const context = createProcessContext({
          sdk,
          activity,
          getToken: createBotTokenGetter(app),
        });

        // For invoke activities, send HTTP 200 immediately before running
        // handler logic so slow operations (file uploads, reflections) don't
        // hit Teams invoke timeouts ("unable to reach app").
        if (isInvoke) {
          response.status(200).send();
        }

        await logic(context);

        if (!isInvoke) {
          response.status(200).send();
        }
      } catch (err) {
        if (!isInvoke) {
          response.status(500).send({ error: formatUnknownError(err) });
        }
      }
    },

    async updateActivity(_context, _activity) {
      // No-op: updateActivity is handled via REST in streaming-message.ts
    },

    async deleteActivity(_context, _reference) {
      // No-op: deleteActivity not yet implemented for Teams SDK adapter
    },
  };
}

export async function loadMSTeamsSdkWithAuth(creds: MSTeamsCredentials) {
  const sdk = await loadMSTeamsSdk();
  const app = await createMSTeamsApp(creds, sdk);
  return { sdk, app };
}

/**
 * Bot Framework issuer → JWKS mapping.
 * During Microsoft's transition, inbound service tokens can be signed by either
 * the legacy Bot Framework issuer or the Entra issuer. Each gets its own JWKS
 * endpoint so we verify signatures with the correct key set.
 */
const BOT_FRAMEWORK_ISSUERS: ReadonlyArray<{
  issuer: string | ((tenantId: string) => string);
  jwksUri: string;
}> = [
  {
    issuer: "https://api.botframework.com",
    jwksUri: "https://login.botframework.com/v1/.well-known/keys",
  },
  {
    issuer: (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`,
    jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  },
  {
    // SingleTenant bot deployments (Microsoft's default since 2025-07-31) get
    // tokens signed by the Azure AD v1 endpoint, whose issuer is scoped to the
    // bot's tenant. This must be a function so each deployment accepts its own
    // tenant rather than a single hardcoded one (#64270).
    issuer: (tenantId: string) => `https://sts.windows.net/${tenantId}/`,
    jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  },
];

type BotFrameworkJwtDeps = {
  jwt: typeof import("jsonwebtoken");
  JwksClient: typeof import("jwks-rsa").JwksClient;
};

let botFrameworkJwtDepsPromise: Promise<BotFrameworkJwtDeps> | null = null;

async function loadBotFrameworkJwtDeps(): Promise<BotFrameworkJwtDeps> {
  botFrameworkJwtDepsPromise ??= Promise.all([import("jsonwebtoken"), import("jwks-rsa")]).then(
    ([jwt, { JwksClient }]) => ({ jwt, JwksClient }),
  );
  return botFrameworkJwtDepsPromise;
}

/**
 * Create a Bot Framework JWT validator using jsonwebtoken + jwks-rsa directly.
 *
 * The @microsoft/teams.apps JwtValidator hardcodes audience to [clientId, api://clientId],
 * which rejects valid Bot Framework tokens that carry aud: "https://api.botframework.com".
 * This implementation uses jsonwebtoken directly with the correct audience list, matching
 * the behavior of the legacy @microsoft/agents-hosting authorizeJWT middleware.
 *
 * Security invariants:
 * - signature verification via issuer-specific JWKS endpoints
 * - audience validation: appId, api://appId, and https://api.botframework.com
 * - issuer validation: strict allowlist (Bot Framework + tenant-scoped Entra)
 * - expiration validation with 5-minute clock tolerance
 */
export async function createBotFrameworkJwtValidator(creds: MSTeamsCredentials): Promise<{
  validate: (authHeader: string) => Promise<boolean>;
}> {
  const { jwt, JwksClient } = await loadBotFrameworkJwtDeps();

  const allowedAudiences: [string, ...string[]] = [
    creds.appId,
    `api://${creds.appId}`,
    "https://api.botframework.com",
  ];

  const allowedIssuers = BOT_FRAMEWORK_ISSUERS.map((entry) =>
    typeof entry.issuer === "function" ? entry.issuer(creds.tenantId) : entry.issuer,
  ) as [string, ...string[]];

  // One JWKS client per distinct endpoint, cached for the validator lifetime.
  const jwksClients = new Map<string, InstanceType<typeof JwksClient>>();
  function getJwksClient(uri: string): InstanceType<typeof JwksClient> {
    let client = jwksClients.get(uri);
    if (!client) {
      client = new JwksClient({
        jwksUri: uri,
        cache: true,
        cacheMaxAge: 600_000,
        rateLimit: true,
      });
      jwksClients.set(uri, client);
    }
    return client;
  }

  /** Decode the token header without verification to determine the kid. */
  function decodeHeader(token: string): { kid?: string } | null {
    const decoded = jwt.decode(token, { complete: true });
    return decoded && typeof decoded === "object" ? (decoded.header as { kid?: string }) : null;
  }

  /** Resolve the issuer entry for a token's issuer claim (pre-verification). */
  function resolveIssuerEntry(issuerClaim: string | undefined) {
    if (!issuerClaim) {
      return undefined;
    }
    return BOT_FRAMEWORK_ISSUERS.find((entry) => {
      const expected =
        typeof entry.issuer === "function" ? entry.issuer(creds.tenantId) : entry.issuer;
      return expected === issuerClaim;
    });
  }

  return {
    async validate(authHeader: string, _serviceUrl?: string): Promise<boolean> {
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
      if (!token) {
        return false;
      }

      // Decode without verification to extract issuer and kid for key lookup.
      const header = decodeHeader(token);
      const unverifiedPayload = jwt.decode(token) as { iss?: string } | null;
      if (!header?.kid || !unverifiedPayload?.iss) {
        return false;
      }

      // Resolve which JWKS endpoint to use based on the issuer claim.
      const issuerEntry = resolveIssuerEntry(unverifiedPayload.iss);
      if (!issuerEntry) {
        return false;
      }

      const client = getJwksClient(issuerEntry.jwksUri);
      try {
        const signingKey = await client.getSigningKey(header.kid);
        const publicKey = signingKey.getPublicKey();
        jwt.verify(token, publicKey, {
          audience: allowedAudiences,
          issuer: allowedIssuers,
          algorithms: ["RS256"],
          clockTolerance: 300,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
