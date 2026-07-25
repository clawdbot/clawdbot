import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  ClickClackHttpError,
  isClickClackChannelNameConflict,
  type ClickClackClient,
} from "../http-client.js";
import type { ResolvedClickClackAccount } from "../types.js";
import {
  clearDiscussionBindingGeneration,
  listPendingDiscussionOpens,
  recordPendingDiscussionOpen,
  reserveDiscussionBindingGeneration,
  type PendingDiscussionOpen,
} from "./binding-generation.js";
import type {
  ClickClackDiscussionBinding,
  ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { normalizedServerBaseUrl } from "./eligibility.js";
import {
  discussionCredentialFingerprint,
  discussionExternalRef,
  fallbackDiscussionLabel,
  resolveDiscussionLabel,
  slugifyDiscussionLabel,
} from "./naming.js";
import { markClickClackDiscussionChannelIdentityRevoked } from "./revoked-channel-store.js";

const CHANNEL_NAME_MUTATION_ATTEMPTS = 4;

type OpenDiscussionParams = {
  runtime: PluginRuntime;
  store: ClickClackDiscussionBindingStore;
  account: ResolvedClickClackAccount;
  clientFactory: (account: ResolvedClickClackAccount) => ClickClackClient;
  installationId: string;
  bindingGenerationFactory: () => string;
  sessionKey: string;
  ensureTimer: () => void;
  reconcilePendingOpen: (pending: PendingDiscussionOpen) => Promise<void>;
  withChannelMutationLock: <T>(run: () => Promise<T>) => Promise<T>;
  finalizePendingBinding: (sessionKey: string, binding: ClickClackDiscussionBinding) => void;
  warn: (message: string) => void;
};

function isDefinitiveNoCreateHttpError(error: unknown): boolean {
  if (!(error instanceof ClickClackHttpError) || error.status < 400 || error.status >= 500) {
    return false;
  }
  // Timeout, conflict, early-data, and rate-limit responses can follow a committed
  // request or positively indicate an existing external_ref. Reconcile those.
  return ![408, 409, 425, 429].includes(error.status);
}

export function controlSessionUrl(
  baseUrl: string | undefined,
  sessionKey: string,
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/chat`;
  url.hash = "";
  url.searchParams.set("session", sessionKey);
  return url.toString();
}

export async function resolveAvailableChannelName(params: {
  client: ClickClackClient;
  workspaceId: string;
  label: string;
  sessionKey: string;
  ownChannelId?: string;
  channels?: Awaited<ReturnType<ClickClackClient["channels"]>>;
}): Promise<string> {
  const desired = slugifyDiscussionLabel(params.label, params.sessionKey);
  const channels = params.channels ?? (await params.client.channels(params.workspaceId));
  const occupied = new Set(
    channels.filter((channel) => channel.id !== params.ownChannelId).map((channel) => channel.name),
  );
  if (!occupied.has(desired)) {
    return desired;
  }
  const fallback = fallbackDiscussionLabel(params.sessionKey);
  if (!occupied.has(fallback)) {
    return fallback;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${fallback}-${suffix}`;
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
}

export function assertChannelPatch(
  channel: Awaited<ReturnType<ClickClackClient["updateChannel"]>>,
  patch: Parameters<ClickClackClient["updateChannel"]>[1],
): void {
  for (const key of [
    "archived",
    "external_managed",
    "external_ref",
    "external_url",
    "name",
    "sidebar_section",
  ] as const) {
    const expected = patch[key];
    if (expected === undefined) {
      continue;
    }
    const actual =
      key === "external_ref" || key === "external_url" || key === "sidebar_section"
        ? (channel[key] ?? "")
        : channel[key];
    if (actual !== expected) {
      throw new Error(`ClickClack channel update did not apply ${key}`);
    }
  }
}

function assertManagedChannelContract(
  channel: Awaited<ReturnType<ClickClackClient["createChannel"]>>,
  expected: { sessionKey: string; externalRef: string; section: string; externalUrl?: string },
): void {
  if (
    channel.external_managed !== true ||
    (channel.external_ref ?? "") !== (expected.externalRef ?? "") ||
    (channel.sidebar_section ?? "") !== (expected.section ?? "") ||
    (channel.external_url ?? "") !== (expected.externalUrl ?? "")
  ) {
    throw new Error(
      `ClickClack server does not support the managed discussion channel contract for ${expected.sessionKey}`,
    );
  }
}

export function assertManagedChannelListContract(
  channels: Awaited<ReturnType<ClickClackClient["channels"]>>,
): void {
  if (
    channels.some(
      (channel) =>
        typeof channel.external_managed !== "boolean" ||
        (channel.external_ref !== undefined && typeof channel.external_ref !== "string") ||
        (channel.external_url !== undefined && typeof channel.external_url !== "string") ||
        (channel.sidebar_section !== undefined && typeof channel.sidebar_section !== "string"),
    )
  ) {
    throw new Error("ClickClack server does not advertise the managed discussion contract");
  }
}

export async function openClickClackDiscussionBinding(
  params: OpenDiscussionParams,
): Promise<ClickClackDiscussionBinding | undefined> {
  const { account, runtime, sessionKey, store } = params;
  const entry = runtime.agent.session.getSessionEntry({ sessionKey, readConsistency: "latest" });
  if (!entry) {
    return undefined;
  }
  if (!entry.sessionId?.trim()) {
    throw new Error("OpenClaw session does not yet have a concrete session id");
  }
  const client = params.clientFactory(account);
  const workspaces = await client.workspaces();
  const workspace = workspaces.find(
    (candidate) =>
      candidate.id === account.discussions.workspace ||
      candidate.slug === account.discussions.workspace ||
      candidate.name === account.discussions.workspace,
  );
  if (!workspace) {
    throw new Error(`ClickClack discussions workspace not found: ${account.discussions.workspace}`);
  }
  if (!workspace.route_id) {
    throw new Error("ClickClack discussions workspace is missing its route id");
  }
  const serverBaseUrl = normalizedServerBaseUrl(account);
  const credentialFingerprint = discussionCredentialFingerprint(account.token);
  const unresolved = listPendingDiscussionOpens(runtime).find(
    (pending) => pending.sessionKey === sessionKey,
  );
  if (
    unresolved &&
    (unresolved.accountId !== account.accountId ||
      unresolved.credentialFingerprint !== credentialFingerprint ||
      unresolved.sessionId !== entry.sessionId ||
      unresolved.serverBaseUrl !== serverBaseUrl ||
      unresolved.workspaceId !== workspace.id)
  ) {
    await params.reconcilePendingOpen(unresolved);
    if (listPendingDiscussionOpens(runtime).some((pending) => pending.sessionKey === sessionKey)) {
      throw new Error(
        "A previous ClickClack discussion open is still unresolved; restore its credential and retry",
      );
    }
  }

  const label = resolveDiscussionLabel(entry.label, sessionKey);
  const section = entry.category?.trim() || account.discussions.section;
  const externalUrl = controlSessionUrl(account.discussions.controlUrlBase, sessionKey);
  const archived = entry.archivedAt !== undefined;
  return await params.withChannelMutationLock(async () => {
    if (!store.hasCapacity(sessionKey)) {
      throw new Error("ClickClack discussion binding capacity is exhausted");
    }
    let channels = await client.channels(workspace.id);
    assertManagedChannelListContract(channels);
    const destinationIdentity = [serverBaseUrl, workspace.id].join("\0");
    const bindingGeneration = reserveDiscussionBindingGeneration({
      runtime,
      sessionKey,
      destinationIdentity,
      createGeneration: params.bindingGenerationFactory,
    });
    const externalRef = discussionExternalRef(
      params.installationId,
      sessionKey,
      entry.sessionId,
      destinationIdentity,
      bindingGeneration,
    );
    let adopted: (typeof channels)[number] | undefined;
    let managedFields:
      | {
          name: string;
          external_managed: true;
          external_ref: string;
          external_url: string;
          sidebar_section: string;
        }
      | undefined;
    let resolved: Awaited<ReturnType<ClickClackClient["createChannel"]>> | undefined;
    for (let attempt = 0; attempt < CHANNEL_NAME_MUTATION_ATTEMPTS; attempt += 1) {
      adopted = channels.find(
        (candidate) =>
          candidate.external_managed === true && candidate.external_ref === externalRef,
      );
      const name = await resolveAvailableChannelName({
        client,
        workspaceId: workspace.id,
        label,
        sessionKey,
        channels,
        ownChannelId: adopted?.id,
      });
      managedFields = {
        name,
        external_managed: true,
        external_ref: externalRef,
        external_url: externalUrl ?? "",
        sidebar_section: section,
      };
      recordPendingDiscussionOpen({
        runtime,
        sessionKey,
        generation: bindingGeneration,
        pending: {
          accountId: account.accountId,
          serverBaseUrl,
          workspaceId: workspace.id,
          sessionId: entry.sessionId,
          externalRef,
          credentialFingerprint,
        },
      });
      params.ensureTimer();
      try {
        if (adopted) {
          markClickClackDiscussionChannelIdentityRevoked({
            runtime,
            accountId: account.accountId,
            serverBaseUrl,
            channelId: adopted.id,
          });
          resolved = await client.updateChannel(adopted.id, { ...managedFields, archived });
        } else {
          resolved = await client.createChannel(workspace.id, { ...managedFields, kind: "public" });
          markClickClackDiscussionChannelIdentityRevoked({
            runtime,
            accountId: account.accountId,
            serverBaseUrl,
            channelId: resolved.id,
          });
        }
        break;
      } catch (error) {
        const nameConflict = isClickClackChannelNameConflict(error);
        if (nameConflict && attempt < CHANNEL_NAME_MUTATION_ATTEMPTS - 1) {
          // A failed relist leaves the pending reservation for reconciliation.
          channels = await client.channels(workspace.id);
          assertManagedChannelListContract(channels);
          continue;
        }
        const definitiveNoCreate = isDefinitiveNoCreateHttpError(error);
        try {
          const relisted = await client.channels(workspace.id);
          assertManagedChannelListContract(relisted);
          const recovered = relisted.find(
            (candidate) =>
              candidate.external_managed === true && candidate.external_ref === externalRef,
          );
          if (recovered) {
            adopted = recovered;
            markClickClackDiscussionChannelIdentityRevoked({
              runtime,
              accountId: account.accountId,
              serverBaseUrl,
              channelId: recovered.id,
            });
            resolved = await client.updateChannel(recovered.id, { ...managedFields, archived });
            break;
          }
          if (definitiveNoCreate) {
            clearDiscussionBindingGeneration({
              runtime,
              sessionKey,
              expectedGeneration: bindingGeneration,
            });
          }
        } catch {
          if (definitiveNoCreate && !adopted) {
            clearDiscussionBindingGeneration({
              runtime,
              sessionKey,
              expectedGeneration: bindingGeneration,
            });
          }
          // Otherwise the POST outcome is ambiguous and stays quarantined.
        }
        throw error;
      }
    }
    if (!resolved || !managedFields) {
      throw new Error("ClickClack discussion channel name retries were exhausted");
    }
    try {
      assertManagedChannelContract(resolved, { sessionKey, externalRef, section, externalUrl });
      if (adopted) {
        assertChannelPatch(resolved, { ...managedFields, archived });
      }
    } catch (error) {
      try {
        const updated = await client.updateChannel(resolved.id, { archived: true });
        assertChannelPatch(updated, { archived: true });
        clearDiscussionBindingGeneration({
          runtime,
          sessionKey,
          expectedGeneration: bindingGeneration,
        });
      } catch (archiveError) {
        params.warn(
          `failed to archive incompatible discussion channel ${resolved.id}: ${String(archiveError)}`,
        );
      }
      throw error;
    }
    if (!resolved.route_id) {
      try {
        const updated = await client.updateChannel(resolved.id, { archived: true });
        assertChannelPatch(updated, { archived: true });
        clearDiscussionBindingGeneration({
          runtime,
          sessionKey,
          expectedGeneration: bindingGeneration,
        });
      } catch (archiveError) {
        params.warn(
          `failed to archive route-less discussion channel ${resolved.id}: ${String(archiveError)}`,
        );
      }
      throw new Error("ClickClack discussion channel is missing its route id");
    }
    let channel = resolved;
    if (!adopted && archived) {
      channel = await client.updateChannel(resolved.id, { archived: true });
      assertChannelPatch(channel, { archived: true });
    }
    const nextBinding: ClickClackDiscussionBinding = {
      accountId: account.accountId,
      agentId: resolveAgentIdFromSessionKey(sessionKey),
      sessionId: entry.sessionId,
      serverBaseUrl,
      credentialFingerprint,
      externalRef,
      externalUrl: externalUrl ?? "",
      workspaceRef: account.discussions.workspace,
      workspaceId: workspace.id,
      channelId: channel.id,
      channelRouteId: channel.route_id,
      workspaceRouteId: workspace.route_id,
      section,
      archived,
      label,
    };
    const currentEntry = runtime.agent.session.getSessionEntry({
      sessionKey,
      readConsistency: "latest",
    });
    if (!currentEntry || currentEntry.sessionId !== entry.sessionId) {
      try {
        const updated = await client.updateChannel(channel.id, { archived: true });
        assertChannelPatch(updated, { archived: true });
        clearDiscussionBindingGeneration({
          runtime,
          sessionKey,
          expectedGeneration: bindingGeneration,
        });
      } catch (archiveError) {
        params.warn(
          `failed to archive superseded discussion channel ${channel.id}: ${String(archiveError)}`,
        );
      }
      throw new Error("OpenClaw session changed while opening its ClickClack discussion");
    }
    try {
      store.set(sessionKey, nextBinding);
    } catch (error) {
      try {
        const updated = await client.updateChannel(channel.id, { archived: true });
        assertChannelPatch(updated, { archived: true });
        clearDiscussionBindingGeneration({
          runtime,
          sessionKey,
          expectedGeneration: bindingGeneration,
        });
      } catch (archiveError) {
        params.warn(
          `failed to archive unbound discussion channel ${channel.id}: ${String(archiveError)}`,
        );
      }
      throw error;
    }
    params.finalizePendingBinding(sessionKey, nextBinding);
    return nextBinding;
  });
}
