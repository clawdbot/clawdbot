import { html, nothing } from "lit";
import type { SessionsCatalogStartTerminalResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { startCatalogSessionInTerminal } from "../../lib/sessions/catalog-terminal.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";

export function readNewSessionTerminalStartAccess(
  gateway: Parameters<typeof readSessionMethodAccess>[0],
  worktree: boolean,
): SessionMethodAccess {
  const terminalAccess = readSessionMethodAccess(gateway, {
    method: "sessions.catalog.startTerminal",
    requiredScope: "operator.admin",
  });
  return !terminalAccess.allowed || !worktree
    ? terminalAccess
    : readSessionMethodAccess(gateway, {
        method: "worktrees.create",
        requiredScope: "operator.admin",
      });
}

export async function startNewSessionInTerminal(
  client: GatewayBrowserClient,
  params: {
    catalogId: string;
    agentId: string;
    hostId: string;
    cwd: string;
    initialMessage: string;
    worktree: boolean;
    worktreeName: string;
    baseRef: string;
  },
  isCurrent: () => boolean,
): Promise<SessionsCatalogStartTerminalResult | null> {
  let cwd = params.cwd;
  if (params.worktree) {
    const created = await createManagedWorktree(client, {
      repoRoot: cwd,
      name: params.worktreeName,
      baseRef: params.baseRef,
    });
    if (!isCurrent()) {
      return null;
    }
    cwd = created.path;
  }
  return startCatalogSessionInTerminal(
    {
      catalogId: params.catalogId,
      agentId: params.agentId,
      hostId: params.hostId,
      cwd,
      ...(params.initialMessage ? { initialMessage: params.initialMessage } : {}),
    },
    isCurrent,
  );
}

export function renderNewSessionTerminalHost(params: {
  hosts: Array<{ hostId: string; label: string }> | undefined;
  hostId: string;
  submitting: boolean;
  onSelect: (hostId: string) => void;
}) {
  if (!params.hosts) {
    return nothing;
  }
  if (params.hosts.length === 0) {
    return html`<span class="new-session-page__catalog-unavailable" role="status">
      ${t("newSession.nativeHostsUnavailable")}
    </span>`;
  }
  if (params.hosts.length === 1 && params.hosts[0]?.hostId === params.hostId) {
    return nothing;
  }
  return html`<div class="new-session-page__select new-session-page__menu-field">
    <span>${t("newSession.where")}</span>
    <select
      class="new-session-page__trigger"
      aria-label=${t("newSession.where")}
      .value=${params.hostId}
      ?disabled=${params.submitting}
      @change=${(event: Event) => {
        if (event.currentTarget instanceof HTMLSelectElement) {
          params.onSelect(event.currentTarget.value);
        }
      }}
    >
      ${
        !params.hosts.some((host) => host.hostId === params.hostId)
          ? html`<option value=${params.hostId} selected disabled>
              ${t("newSession.chooseNativeHost")}
            </option>`
          : nothing
      }
      ${params.hosts.map(
        (host) => html`<option value=${host.hostId} ?selected=${host.hostId === params.hostId}>
          ${host.label}
        </option>`,
      )}
    </select>
  </div>`;
}
