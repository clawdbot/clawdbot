import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { resolveManagedGitHubProfileDir } from "../agents/github-tool-identity.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { personalGitHubStatus } from "./github-personal-oauth.js";
import {
  SESSION_ID,
  SESSION_KEY,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
} from "./github-publication.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { preparePersonalGitHubSessionAction } from "./server-methods/github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();
export const personalPublicationAccount = { accountId: 101, login: "personal-alice" };
const account = personalPublicationAccount;
const profileId = "ghp_22222222222222222222222222222222";

export async function createPersonalPublicationFixture() {
  const owner = ensureProfileForEmail("alice@example.test").id;
  const otherOwner = ensureProfileForEmail("bob@example.test").id;
  const generation = randomUUID();
  const personalToken = `synthetic-personal-credential-${generation}`;
  updateUserGitHubConnection(
    owner,
    () => ({
      version: 1,
      generation,
      selection: {
        kind: "connected",
        profileId,
        ...account,
        refreshToken: "synthetic-refresh",
        accessExpiresAtMs: Date.now() + 3600000,
        refreshExpiresAtMs: Date.now() + 86400000,
        scopes: ["repo"],
      },
    }),
    () => {},
  );
  const dir = resolveManagedGitHubProfileDir({ scope: "personal", agentId: "", profileId });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(dir, "hosts.yml"),
    stringifyYaml({
      "github.com": {
        user: account.login,
        oauth_token: personalToken,
        users: { [account.login]: { oauth_token: personalToken } },
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(dir, "config.yml"), stringifyYaml({ version: "1" }), {
    mode: 0o600,
  });
  const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
    if (
      url !== "https://api.github.com/user" ||
      new Headers(options?.headers).get("Authorization") !== `Bearer ${personalToken}`
    ) {
      throw new Error("Unexpected credential HTTP request");
    }
    return Response.json({
      id: runtime.verifiedAccount.accountId,
      login: runtime.verifiedAccount.login,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const fallback = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv[0] === "gh" && (argv[1] !== "api" || argv.includes("user"))) {
      throw new Error("Unexpected GitHub CLI credential operation");
    }
    return await fallback(argv, options);
  });
  const client: GatewayClient = {
    connId: "direct-human",
    authenticatedUserProfile: {
      profileId: owner,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      role: "operator",
      scopes: ["operator.write", "operator.read"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  const runtime = { live: true, verifiedAccount: account, client };
  const config: OpenClawConfig = {};
  const context = {
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(runtime.live && (!filter || filter(runtime.client)) ? [runtime.client.connId!] : []),
  } as unknown as GatewayRequestContext;
  const action = preparePersonalGitHubSessionAction({ client, context }, SESSION_KEY);
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  return {
    owner,
    otherOwner,
    generation,
    runtime,
    client,
    config,
    context,
    action,
    placements,
    coordinator,
  };
}

export async function callPersonalPublicationRpc(
  {
    client,
    context,
    coordinator,
  }: Pick<
    Awaited<ReturnType<typeof createPersonalPublicationFixture>>,
    "client" | "context" | "coordinator"
  >,
  method: string,
  params: Record<string, unknown> = { sessionKey: SESSION_KEY },
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: randomUUID(), method, params },
    client,
    context: {
      ...context,
      githubPublicationService: coordinator,
      githubOAuthService: {
        personal: { status: async (statusAction) => personalGitHubStatus(statusAction) },
      } as GatewayRequestContext["githubOAuthService"],
    },
    respond,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0]!;
}

export async function createForeignPublicationSession(otherOwner: string, incognito = false) {
  const entry = {
    sessionId: SESSION_ID,
    updatedAt: Date.now(),
    visibility: "draft" as const,
    ...(incognito ? { incognito: true as const } : {}),
    createdActor: { type: "human" as const, source: "profile" as const, id: otherOwner },
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY }, entry);
  const original = mocks.loadSession.getMockImplementation()!;
  mocks.loadSession.mockImplementation((key: string) => ({
    ...original(key),
    entry: { ...original(key).entry, ...entry },
  }));
}
