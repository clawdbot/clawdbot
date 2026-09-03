import { randomUUID } from "node:crypto";
import type {
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersLinkAuthProfileResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
  UsersUnlinkAuthProfileResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  listPersonalAccountAuthChoices,
  resolvePersonalAccountAuthMethod,
} from "../plugins/personal-account-auth.js";
import { runProviderPluginAuthMethodUnpersisted } from "../plugins/provider-auth-choice.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  readUserModelAccountSummary,
  setUserProfileAuthLink,
} from "../state/user-model-accounts.js";
import { sanitizeWizardStepForClient, WizardSession } from "../wizard/session.js";
import type { ModelAccountConnectAction } from "./model-account-authority.js";

type TerminalResult =
  | Exclude<UsersAuthConnectStatusResult, { status: "pending" | "connected" }>
  | { status: "connected"; authProfileId: string };
type ConnectOperation = {
  id: string;
  owner: string;
  provider: string;
  expiresAtMs: number;
  action: ModelAccountConnectAction;
  answerAction?: ModelAccountConnectAction;
  timeout: NodeJS.Timeout;
  session?: WizardSession;
  terminal?: TerminalResult;
};

const CONNECT_TTL_MS = 15 * 60 * 1_000;
const MAX_ACTIVE_CONNECTS = 8;
const MAX_RETAINED_CONNECTS = 64;

export class ModelAccountConnectAuthorityError extends Error {
  constructor() {
    super("This account action requires a current authorized connection; reconnect and try again.");
  }
}

export class ModelAccountConnectInputError extends Error {}

function matchesLiteralCredential(
  credential: AuthProfileCredential,
  existing: AuthProfileCredential,
) {
  if (credential.provider !== existing.provider) {
    return false;
  }
  return credential.type === "api_key" && existing.type === "api_key"
    ? credential.key === existing.key
    : credential.type === "token" &&
        existing.type === "token" &&
        credential.token === existing.token;
}

function resolveOwnedAccountProvider(owner: string, authProfileId: string): string {
  const account = readUserModelAccountSummary({ profileId: owner, authProfileId });
  if (!account) {
    throw new ModelAccountConnectInputError(
      "Select an account from your personal account list, or add it first.",
    );
  }
  return account.provider;
}

function resolveLinkableAuthProfileProvider(
  cfg: OpenClawConfig,
  owner: string,
  authProfileId: string,
): string | undefined {
  if (isUserModelAuthProfileId(authProfileId)) {
    return resolveOwnedAccountProvider(owner, authProfileId);
  }
  // Stored credentials and config-only routes (e.g. aws-sdk) remain linkable;
  // the caller cannot claim a provider the selected profile does not satisfy.
  const store = ensureAuthProfileStoreWithoutExternalProfiles(resolveSharedMainAuthAgentDir(), {
    readOnly: true,
  });
  return store.profiles[authProfileId]?.provider ?? cfg.auth?.profiles?.[authProfileId]?.provider;
}

/** One Gateway lifetime owns sign-in steps and authority; provider methods only stage credentials. */
export function createModelAccountConnectService(options: {
  getConfig: () => OpenClawConfig;
  onChanged?: () => void;
}) {
  const operations = new Map<string, ConnectOperation>();
  let stopped = false;

  const finish = (operation: ConnectOperation, result: TerminalResult): TerminalResult => {
    if (operation.terminal) {
      return operation.terminal;
    }
    // Revoke before aborting provider I/O. A late callback must never regain
    // commit authority, including when the provider ignores cancellation.
    operation.terminal = result;
    clearTimeout(operation.timeout);
    operation.session?.cancel();
    return result;
  };
  const snapshot = (operation: ConnectOperation) => {
    if (operation.terminal) {
      return operation.terminal;
    }
    if (operation.expiresAtMs <= Date.now()) {
      return finish(operation, { status: "expired" });
    }
    try {
      operation.action.assertCurrent();
      operation.answerAction?.assertCurrent();
    } catch {
      return finish(operation, { status: "failed", reason: "authority" });
    }
    return undefined;
  };
  const assertRunning = (action: ModelAccountConnectAction) => {
    if (stopped) {
      throw new ModelAccountConnectAuthorityError();
    }
    action.assertCurrent();
  };
  const assertLive = (operation: ConnectOperation) => {
    if (stopped || operations.get(operation.id) !== operation || snapshot(operation)) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  const projectResult = (
    action: ModelAccountConnectAction,
    operation: ConnectOperation,
  ): UsersAuthConnectStatusResult => {
    const result = snapshot(operation);
    if (!result) {
      const step = operation.session?.getCurrentStep();
      return { status: "pending", ...(step ? { step: sanitizeWizardStepForClient(step) } : {}) };
    }
    if (result.status !== "connected") {
      return result;
    }
    // Replays retain the committed account, but never replay an obsolete default link.
    assertRunning(action);
    return { ...result, links: listUserProfileAuthLinks(operation.owner) };
  };
  const findOperation = (action: ModelAccountConnectAction, connectId: string) => {
    assertRunning(action);
    const operation = operations.get(connectId);
    return operation?.owner === action.owner ? operation : undefined;
  };
  const supersede = (owner: string, provider: string) => {
    for (const operation of operations.values()) {
      if (operation.owner === owner && operation.provider === provider) {
        finish(operation, { status: "cancelled" });
      }
    }
  };
  const setLink = (action: ModelAccountConnectAction, provider: string, authProfileId: string) => {
    const links = setUserProfileAuthLink({
      profileId: action.owner,
      provider,
      authProfileId,
      assertCurrent: () => assertRunning(action),
    });
    supersede(action.owner, provider);
    options.onChanged?.();
    return { links };
  };

  return {
    listLinks(action: ModelAccountConnectAction): UsersListAuthLinksResult {
      assertRunning(action);
      return { links: listUserProfileAuthLinks(action.owner) };
    },
    link(action: ModelAccountConnectAction, authProfileId: string): UsersLinkAuthProfileResult {
      assertRunning(action);
      const provider = resolveLinkableAuthProfileProvider(
        options.getConfig(),
        action.owner,
        authProfileId,
      );
      if (!provider) {
        throw new ModelAccountConnectInputError(
          `unknown auth profile "${authProfileId}"; sign the account in first with "openclaw models auth login --provider <id> --profile-id ${authProfileId}", then link it`,
        );
      }
      return setLink(action, provider, authProfileId);
    },
    unlink(action: ModelAccountConnectAction, provider: string): UsersUnlinkAuthProfileResult {
      assertRunning(action);
      const links = clearUserProfileAuthLink({
        profileId: action.owner,
        provider,
        assertCurrent: () => assertRunning(action),
      });
      supersede(action.owner, provider);
      options.onChanged?.();
      return { links };
    },
    list(action: ModelAccountConnectAction, cursor?: string): UsersListModelAccountsResult {
      assertRunning(action);
      return {
        profileId: action.owner,
        ...listUserModelAccounts({ profileId: action.owner, cursor }),
        links: listUserProfileAuthLinks(action.owner),
      };
    },
    catalog(action: ModelAccountConnectAction): UsersAuthConnectCatalogResult {
      assertRunning(action);
      const providers = new Map<string, UsersAuthConnectCatalogResult["providers"][number]>();
      for (const choice of listPersonalAccountAuthChoices(options.getConfig())) {
        let provider = providers.get(choice.providerId);
        if (!provider) {
          provider = {
            id: choice.providerId,
            label: choice.groupLabel ?? choice.providerId,
            methods: [],
          };
          providers.set(choice.providerId, provider);
        }
        if (!provider.methods.some((method) => method.id === choice.methodId)) {
          provider.methods.push({
            id: choice.methodId,
            label: choice.choiceLabel,
            ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
          });
        }
      }
      assertRunning(action);
      return { providers: [...providers.values()] };
    },
    select(
      action: ModelAccountConnectAction,
      authProfileId: string,
    ): UsersSelectModelAccountResult {
      assertRunning(action);
      return setLink(
        action,
        resolveOwnedAccountProvider(action.owner, authProfileId),
        authProfileId,
      );
    },
    async start(
      action: ModelAccountConnectAction,
      provider: string,
      methodId: string,
    ): Promise<UsersAuthConnectStartResult> {
      assertRunning(action);
      for (const operation of operations.values()) {
        snapshot(operation);
      }
      supersede(action.owner, provider);
      if (
        [...operations.values()].filter((operation) => !operation.terminal).length >=
        MAX_ACTIVE_CONNECTS
      ) {
        throw new Error("Too many model-account sign-ins are in progress; try again shortly.");
      }
      for (const [id, operation] of operations) {
        if (operations.size < MAX_RETAINED_CONNECTS) {
          break;
        }
        if (operation.terminal) {
          operations.delete(id);
        }
      }
      const id = randomUUID();
      const operation: ConnectOperation = {
        id,
        owner: action.owner,
        provider,
        action,
        expiresAtMs: Date.now() + CONNECT_TTL_MS,
        timeout: setTimeout(() => finish(operation, { status: "expired" }), CONNECT_TTL_MS),
      };
      operation.timeout.unref();
      operations.set(id, operation);
      let resolvedMethod;
      try {
        resolvedMethod = await resolvePersonalAccountAuthMethod(
          options.getConfig(),
          provider,
          methodId,
        );
        assertLive(operation);
        if (!resolvedMethod) {
          throw new ModelAccountConnectInputError(
            "This sign-in method is unavailable for personal accounts. Choose a method from Connected accounts.",
          );
        }
      } catch (error) {
        snapshot(operation);
        finish(operation, { status: "failed", reason: "unavailable" });
        throw error;
      }
      const method = resolvedMethod;
      operation.session = new WizardSession(async (prompter, signal) => {
        // Constructor runners start immediately; yield until the operation owns
        // its session so synchronous provider failures can also be cancelled.
        await Promise.resolve();
        let failure: "exchange" | "unavailable" = "exchange";
        try {
          assertLive(operation);
          const result = await runProviderPluginAuthMethodUnpersisted({
            config: {},
            env: {},
            method,
            prompter,
            signal,
            assertCurrent: () => assertLive(operation),
            isRemote: true,
            secretInputMode: "plaintext",
            allowSecretRefPrompt: false,
            runtime: {
              log: () => {},
              error: () => {},
              exit: () => {
                throw new Error("Provider sign-in stopped.");
              },
            },
          });
          assertLive(operation);
          const profile = result.profiles[0];
          if (
            result.profiles.length !== 1 ||
            !profile ||
            profile.credential.provider !== provider ||
            profile.secretStorage
          ) {
            finish(operation, { status: "failed", reason: "identity" });
            return;
          }
          // The private store repeats this guard inside its synchronous commit.
          // Config patches, shared profile IDs, and global defaults are not applied.
          failure = "unavailable";
          const connected = connectUserModelAccount({
            ownerProfileId: operation.owner,
            credential: profile.credential,
            matchesCredential: (existing) =>
              (method.matchesPersonalAccount ?? matchesLiteralCredential)(
                profile.credential,
                existing,
              ),
            assertCurrent: () => assertLive(operation),
          });
          finish(operation, { status: "connected", authProfileId: connected.authProfileId });
          options.onChanged?.();
        } catch {
          snapshot(operation);
          finish(operation, { status: "failed", reason: failure });
        }
      });
      return { connectId: id, expiresAtMs: operation.expiresAtMs };
    },
    status(action: ModelAccountConnectAction, connectId: string): UsersAuthConnectStatusResult {
      const operation = findOperation(action, connectId);
      return operation ? projectResult(action, operation) : { status: "expired" };
    },
    async answer(
      action: ModelAccountConnectAction,
      connectId: string,
      stepId: string,
      value?: unknown,
    ): Promise<UsersAuthConnectStatusResult> {
      const operation = findOperation(action, connectId);
      if (!operation) {
        return { status: "expired" };
      }
      if (snapshot(operation)) {
        return projectResult(action, operation);
      }
      const step = operation.session?.getCurrentStep();
      if (!operation.session || step?.id !== stepId || step.type === "progress") {
        // A browser callback can retire the displayed prompt before its answer
        // arrives. Ignore that value without cancelling the advancing sign-in.
        const result = projectResult(action, operation);
        return result.status === "pending"
          ? { ...result, error: "This step has changed. Follow the current sign-in instructions." }
          : result;
      }
      if (step.sensitive && typeof value === "string") {
        registerSecretValueForRedaction(value);
      }
      operation.answerAction = action;
      // Bind the answerer's authority before resolving the provider's prompt;
      // its continuation may commit before this await returns.
      const error = await operation.session.answer(stepId, value);
      assertRunning(action);
      const result = projectResult(action, operation);
      if (error && result.status === "pending" && result.step?.id === stepId) {
        return {
          ...result,
          error: "That answer is not valid. Check the sign-in instructions and try again.",
        };
      }
      return result;
    },
    cancel(action: ModelAccountConnectAction, connectId: string): UsersAuthConnectStatusResult {
      const operation = findOperation(action, connectId);
      if (!operation) {
        return { status: "expired" };
      }
      snapshot(operation);
      finish(operation, { status: "cancelled" });
      return projectResult(action, operation);
    },
    supersede,
    async stop(): Promise<void> {
      stopped = true;
      for (const operation of operations.values()) {
        finish(operation, { status: "cancelled" });
      }
      // Provider cancellation owns its callback/poll cleanup. An uncooperative
      // remote request cannot keep the Gateway alive or retain commit authority.
      operations.clear();
    },
  };
}
