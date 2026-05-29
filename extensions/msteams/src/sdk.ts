import * as fs from "node:fs";
import { normalizeBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import type { MSTeamsCloudName } from "./cloud.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";
import { buildOpenClawUserAgentFragment } from "./user-agent.js";

/**
 * Structural shape of the SDK's HTTP server adapter (e.g. `ExpressAdapter`).
 * Modeled here rather than imported from `@microsoft/teams.apps` because the
 * SDK's barrel re-exports `ExpressAdapter` / `IHttpServerAdapter` through a
 * folder-with-index.d.ts chain (`export * from "./http"`) that NodeNext
 * resolution doesn't follow through every tsconfig setup in this repo.
 * This keeps the Teams SDK type-import surface to just `App`.
 */
type MSTeamsHttpServerAdapter = {
  registerRoute(method: string, path: string, handler: unknown): void;
  start?(port: number | string): Promise<void>;
  stop?(): Promise<void>;
};

type MSTeamsExpressAdapterCtor = new (
  serverOrApp?: unknown,
  options?: { logger?: unknown; onError?: (err: Error) => void },
) => MSTeamsHttpServerAdapter;

/**
 * Resolved Teams SDK modules loaded lazily to avoid importing when the
 * provider is disabled. `ExpressAdapter` is held as a constructor type
 * because the SDK's chained `export *` barrel doesn't expose its class type
 * through every tsconfig in this repo (see `MSTeamsHttpServerAdapter`).
 */
type TeamsSdkModules = {
  App: typeof import("@microsoft/teams.apps").App;
  ExpressAdapter: MSTeamsExpressAdapterCtor;
  cloudFromName: (name: string) => unknown;
};

/**
 * Borrow the SDK's `IRoutes` map so `app.on("<route-name>", (ctx) => …)`
 * gets route-name validation and ctx inference. We define our own `on`
 * signature instead of borrowing the SDK's free function (which is bound to
 * `this: App<TPlugin>`), because our `MSTeamsApp` is a structural alias —
 * not a real `App` instance.
 */
type MSTeamsRoutes = import("@microsoft/teams.apps/dist/routes/index.js").IRoutes;

/** Adaptive-card action response shape, re-exported for typed `card.action` handlers. */
export type MSTeamsCardActionResponse =
  import("@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-action-response.js").AdaptiveCardActionResponse;

/**
 * Typed `on` registration. The route-specific overloads below are tsgo
 * workarounds — every typed SDK route is affected to some degree.
 *
 * Real tsc resolves `IRoutes["<route>"]` to the route-specific
 * `RouteHandler<X, InvokeResponse | …>` declared in the SDK (verified in
 * VS Code), but tsgo collapses `@microsoft/teams.api`'s `Activity`
 * discriminated union to `any` because its hashed declarations don't
 * resolve cleanly across deep subpaths. That turns
 * `ActivityRoutes = [K in Activity["type"]]?: RouteHandler<X>` into a
 * `[string]: RouteHandler<X, void>` index signature, and the intersection
 * in `IRoutes` then forces every route's `Out` to be `void`-compatible.
 * Routes whose declared return already includes `void` (`file.consent.*`,
 * `activity`, all the `signin.*` paths) coincidentally still typecheck;
 * routes whose declared return does not (`card.action`) blow up.
 *
 * Each overload here corresponds to a route we actually register from this
 * plugin, with the typed return the SDK expects at runtime. If we add a
 * new typed route, add a matching overload. The generic fallback at the
 * end keeps route-name validation for everything else.
 *
 * Tracking upstream — same family of tsgo discriminated-union resolution
 * bugs: https://github.com/microsoft/typescript-go/issues/1057 (Post-7.0).
 */
/** Per-route ctx aliases. Pulled from SDK subpaths that don't go through the broken `Activity` union resolution. */
type CardActionCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivityContext<
  import("@microsoft/teams.api/dist/activities/invoke/adaptive-card/action.js").IAdaptiveCardActionInvokeActivity
>;
type FileConsentCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivityContext<
  import("@microsoft/teams.api/dist/activities/invoke/file-consent.js").IFileConsentInvokeActivity
>;
type ActivityCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivityContext;
type SigninTokenExchangeCtx =
  import("@microsoft/teams.apps/dist/contexts/index.js").IActivityContext<
    import("@microsoft/teams.api/dist/activities/invoke/sign-in/token-exchange.js").ISignInTokenExchangeInvokeActivity
  >;
type SigninVerifyStateCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivityContext<
  import("@microsoft/teams.api/dist/activities/invoke/sign-in/verify-state.js").ISignInVerifyStateInvokeActivity
>;
type MessageSubmitCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivityContext<
  import("@microsoft/teams.api/dist/activities/invoke/message/submit-action.js").IMessageSubmitActionInvokeActivity
>;
type SigninEventCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivitySignInContext;

type MSTeamsAppOn = {
  // Adaptive card actions (Action.Execute Universal Action Model). Typed
  // return: InvokeResponse<'adaptiveCard/action'> | AdaptiveCardActionResponse.
  (
    name: "card.action",
    cb: (ctx: CardActionCtx) => MSTeamsCardActionResponse | Promise<MSTeamsCardActionResponse>,
  ): MSTeamsApp;
  // File-consent accept/decline. Typed return is `InvokeResponse | void`,
  // so a void-returning cb satisfies it; the overloads exist for parity
  // with the other registered routes and so the call sites read uniformly.
  (
    name: "file.consent.accept" | "file.consent.decline",
    cb: (ctx: FileConsentCtx) => void | Promise<void>,
  ): MSTeamsApp;
  // SSO sign-in invokes. The monitor registers guarded replacement routes and
  // delegates back into the SDK handlers after OpenClaw sender policy passes.
  (name: "signin.token-exchange", cb: (ctx: SigninTokenExchangeCtx) => unknown): MSTeamsApp;
  (name: "signin.verify-state", cb: (ctx: SigninVerifyStateCtx) => unknown): MSTeamsApp;
  // Feedback (thumbs up/down) on AI-generated messages — Teams delivers
  // this as a `message/submitAction` invoke with `actionName === "feedback"`.
  // Typed return is `InvokeResponse | void`, so a void-returning cb works.
  (name: "message.submit", cb: (ctx: MessageSubmitCtx) => void | Promise<void>): MSTeamsApp;
  // Activity catch-all. Default void return — used as our dispatch into
  // the BotBuilder-shaped handler.
  (name: "activity", cb: (ctx: ActivityCtx) => void | Promise<void>): MSTeamsApp;
  // Generic fallback — any other route name validates against IRoutes.
  <
    Name extends Exclude<
      keyof MSTeamsRoutes,
      | "card.action"
      | "file.consent.accept"
      | "file.consent.decline"
      | "signin.token-exchange"
      | "signin.verify-state"
      | "message.submit"
      | "activity"
    >,
  >(
    name: Name,
    cb: Exclude<MSTeamsRoutes[Name], undefined>,
  ): MSTeamsApp;
};

/**
 * Structural interface for the Teams SDK App. Most of the surface is kept
 * loose to avoid tsgo resolution bugs with @microsoft/teams.api hashed
 * declaration files, but `on` mirrors the SDK's typed-route generic so
 * handlers (e.g. `app.on("file.consent.accept", (ctx) => …)`) get proper
 * route-name validation and ctx inference.
 */
export type MSTeamsApp = {
  send(conversationId: string, activity: unknown): Promise<{ id?: string }>;
  /**
   * Threaded variant of `send` for channel/groupchat replies. The SDK builds
   * the threaded conversation id internally (`${conversationId};messageid=${messageId}`)
   * via its `toThreadedConversationId` helper, so we don't have to reproduce
   * Teams' URL format on our side.
   */
  reply(conversationId: string, messageId: string, activity: unknown): Promise<{ id?: string }>;
  on: MSTeamsAppOn;
  event(name: "signin", cb: (ctx: SigninEventCtx) => void | Promise<void>): MSTeamsApp;
  initialize(): Promise<void>;
  tokenManager: {
    getGraphToken(): Promise<unknown>;
    getBotToken(): Promise<unknown>;
  };
  cloud?: {
    graphScope?: string;
  };
  api: {
    serviceUrl?: string;
    conversations: {
      activities(conversationId: string): {
        update(activityId: string, activity: unknown): Promise<unknown>;
        delete(activityId: string): Promise<unknown>;
      };
    };
  };
};

/**
 * Token provider compatible with the existing codebase, wrapping the Teams
 * SDK App's public tokenManager.
 */
export type MSTeamsTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
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
};

const AZURE_IDENTITY_MODULE = "@azure/identity";

let azureIdentityModulePromise: Promise<AzureIdentityModule> | null = null;

async function loadAzureIdentity(): Promise<AzureIdentityModule> {
  azureIdentityModulePromise ??= import(AZURE_IDENTITY_MODULE) as Promise<AzureIdentityModule>;
  return azureIdentityModulePromise;
}

let sdkAppPromise: Promise<TeamsSdkModules> | null = null;

async function loadSdkModules(): Promise<TeamsSdkModules> {
  sdkAppPromise ??= Promise.all([
    import("@microsoft/teams.apps"),
    import("@microsoft/teams.api"),
  ]).then(([apps, api]) => ({
    App: apps.App,
    // ExpressAdapter is in the runtime barrel but its type is hidden behind
    // the SDK's chained `export *` (see MSTeamsHttpServerAdapter comment).
    // Cast to the structural constructor we model locally so the seam stays
    // typed without depending on the SDK's namespace shape.
    ExpressAdapter: (apps as unknown as { ExpressAdapter: MSTeamsExpressAdapterCtor })
      .ExpressAdapter,
    cloudFromName: (api as unknown as { cloudFromName: (name: string) => unknown }).cloudFromName,
  }));
  return sdkAppPromise;
}

/**
 * Lazily construct an ExpressAdapter that the Teams SDK App can register its
 * routes on. The dynamic import keeps the SDK bundle off the hot startup path
 * when msteams is disabled; the structural return type matches what
 * `loadMSTeamsSdkWithAuth` accepts as its `httpServerAdapter` option.
 */
export async function createMSTeamsExpressAdapter(
  serverOrApp: unknown,
): Promise<MSTeamsHttpServerAdapter> {
  const { ExpressAdapter } = await loadSdkModules();
  return new ExpressAdapter(serverOrApp);
}

/**
 * Options for creating a Teams SDK App instance.
 */
export type CreateMSTeamsAppOptions = {
  /**
   * HTTP server adapter to use. When an Express app is available (monitor
   * mode), pass an ExpressAdapter so the SDK registers routes and handles
   * JWT validation. When omitted, the SDK creates a default ExpressAdapter
   * (no server starts until app.start() is called).
   *
   * Use {@link createMSTeamsExpressAdapter} to construct a properly-typed
   * adapter from an Express application.
   */
  httpServerAdapter?: MSTeamsHttpServerAdapter;
  /**
   * Custom messaging endpoint path.
   * @default '/api/messages'
   */
  messagingEndpoint?: `/${string}`;
  /**
   * OAuth connection name used by the SDK's built-in sign-in handlers.
   * @default 'graph'
   */
  oauthDefaultConnectionName?: string;
  /** Teams SDK cloud environment. Defaults to Public. */
  cloud?: MSTeamsCloudName;
  /** Bot Connector service URL for SDK app-level proactive operations. */
  serviceUrl?: string;
  /** Injectable SDK HTTP client. Used by focused tests; production uses SDK defaults. */
  httpClient?: unknown;
};

/**
 * Create a Teams SDK App instance from credentials. The App manages token
 * acquisition, JWT validation, and the HTTP server lifecycle.
 *
 * Auth modes:
 * - Secret: clientId + clientSecret → MSAL client credential flow (SDK built-in)
 * - Managed identity: clientId + managedIdentityClientId → SDK built-in MI support
 * - Certificate: clientId + custom token provider via @azure/identity
 */
export async function createMSTeamsApp(
  creds: MSTeamsCredentials,
  options?: CreateMSTeamsAppOptions,
): Promise<MSTeamsApp> {
  const { App, cloudFromName } = await loadSdkModules();
  // Tag outbound SDK HTTP calls with a User-Agent fragment so the Teams
  // backend can identify OpenClaw traffic for usage telemetry. Teams SDK
  // 2.0.11+ preserves both its own `teams.ts[apps]/<sdk-version>` identifier
  // and caller-provided User-Agent fragments when plain client headers are used.
  const cloud = options?.cloud ?? "Public";
  const serviceUrl = options?.serviceUrl
    ? normalizeBotFrameworkServiceUrl(options.serviceUrl)
    : undefined;
  const appOptions: Record<string, unknown> = {
    client: options?.httpClient ?? {
      headers: { "User-Agent": buildOpenClawUserAgentFragment() },
    },
    ...(options?.httpServerAdapter ? { httpServerAdapter: options.httpServerAdapter } : {}),
    ...(options?.messagingEndpoint ? { messagingEndpoint: options.messagingEndpoint } : {}),
    cloud: cloudFromName(cloud),
    ...(serviceUrl ? { serviceUrl } : {}),
    ...(options?.oauthDefaultConnectionName
      ? { oauth: { defaultConnectionName: options.oauthDefaultConnectionName } }
      : {}),
  };

  if (creds.type === "federated") {
    return createFederatedApp(creds, App, appOptions);
  }
  return new App({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
    ...appOptions,
  } as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
}

function createFederatedApp(
  creds: MSTeamsFederatedCredentials,
  App: TeamsSdkModules["App"],
  appOptions: Record<string, unknown>,
): MSTeamsApp {
  if (creds.useManagedIdentity) {
    // The SDK handles managed identity natively — pass managedIdentityClientId
    // and it selects the right credential flow (system MI, user MI, or FIC).
    return new App({
      clientId: creds.appId,
      tenantId: creds.tenantId,
      managedIdentityClientId: creds.managedIdentityClientId ?? "system",
      ...appOptions,
    } as unknown as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
  }

  // Certificate-based auth — the SDK doesn't have built-in cert support,
  // so we use AppOptions.token with @azure/identity's ClientCertificateCredential.
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

  return createCertificateApp(creds, privateKey, App, appOptions);
}

function createCertificateApp(
  creds: MSTeamsFederatedCredentials,
  privateKey: string,
  App: TeamsSdkModules["App"],
  appOptions: Record<string, unknown>,
): MSTeamsApp {
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

  return new App({
    clientId: creds.appId,
    tenantId: creds.tenantId,
    token: tokenProvider,
    ...appOptions,
  } as unknown as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
}

/**
 * Build a token provider that uses the Teams SDK App's public tokenManager
 * for token acquisition.
 */
export function createMSTeamsTokenProvider(app: MSTeamsApp): MSTeamsTokenProvider {
  const tokenToString = (token: unknown): string => {
    if (token == null) {
      return "";
    }
    return (token as { toString(): string }).toString();
  };
  return {
    async getAccessToken(scope: string): Promise<string> {
      if (
        scope.includes("graph.microsoft.com") ||
        scope.includes("graph.microsoft.us") ||
        scope.includes("microsoftgraph.chinacloudapi.cn")
      ) {
        if (app.cloud?.graphScope?.includes("microsoftgraph.chinacloudapi.cn")) {
          throw new Error(
            "Microsoft Teams Graph operations are not supported for channels.msteams.cloud=China until Graph requests are routed through the Azure China Graph endpoint.",
          );
        }
        return tokenToString(await app.tokenManager.getGraphToken());
      }
      return tokenToString(await app.tokenManager.getBotToken());
    },
  };
}

export async function loadMSTeamsSdkWithAuth(
  creds: MSTeamsCredentials,
  options?: CreateMSTeamsAppOptions,
) {
  const app = await createMSTeamsApp(creds, options);
  return { app };
}
