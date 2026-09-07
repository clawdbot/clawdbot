/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

type AgentSelectionListeners = {
  state: { selectedId: string | null; scopeId: string | null };
  setScope: (scopeId: string | null) => void;
  subscribe: (listener: () => void) => () => void;
};

function withNotifyingAgentSelection(
  base: ApplicationContext,
  initialScopeId: string | null,
): {
  context: ApplicationContext;
  selection: AgentSelectionListeners;
  changeScope: (next: string | null) => void;
} {
  const listeners = new Set<() => void>();
  const state = { selectedId: base.agentSelection.state.selectedId, scopeId: initialScopeId };
  const selection: AgentSelectionListeners = {
    state,
    setScope: (scopeId) => {
      if (state.scopeId === scopeId) {
        return;
      }
      state.scopeId = scopeId;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const context = {
    ...base,
    agentSelection: {
      ...base.agentSelection,
      state,
      subscribe: selection.subscribe,
      setScope: selection.setScope,
    },
  } as ApplicationContext;
  return {
    context,
    selection,
    changeScope: selection.setScope,
  };
}

async function setupArchivedPageWithSelection(
  scopeId: string | null,
  sessions: SessionCapability,
): Promise<{
  page: TestSessionsPage;
  context: ApplicationContext;
  changeScope: (next: string | null) => void;
}> {
  const { gateway } = createGateway({} as GatewayBrowserClient);
  const baseContext = createContext(gateway, sessions);
  const { context, changeScope } = withNotifyingAgentSelection(baseContext, scopeId);
  const page = await createRenderedPage(
    context,
    {
      count: 1,
      sessions: [{ key: "agent:writer:old-1", archived: true }],
    } as SessionsListResult,
    "archived",
  );
  return { page, context, changeScope };
}

describe("sessions page Delete all archived agent-scope retirement", () => {
  it("retires the in-flight enumeration when agent scope changes before any page resolves", async () => {
    const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
    const listResponse = createDeferred<SessionsListResult>();
    const list = vi.fn(() => listResponse.promise) as unknown as SessionCapability["list"];
    const deleteMany = vi.fn(async () => ({
      deleted: writerKeys,
      errors: [],
      preservedWorktrees: [],
    }));
    const sessions = createSessions({
      list,
      deleteMany,
    });
    const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    const operation = page.deleteAllArchived();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    // The captured scope held `writer`; the operator now switches the page to
    // `main` while the first enumeration page is still in flight.
    changeScope("main");
    listResponse.resolve({
      count: writerKeys.length,
      totalCount: writerKeys.length,
      sessions: writerKeys.map((key) => ({
        key,
        kind: "direct",
        updatedAt: 1,
        archived: true,
      })),
    } as SessionsListResult);
    await operation;

    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBeNull();
  });

  it("retires the post-confirm destructive intent when agent scope changes while confirmation is open", async () => {
    const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
    const list = vi.fn(async () => ({
      count: writerKeys.length,
      totalCount: writerKeys.length,
      sessions: writerKeys.map((key) => ({ key, archived: true })),
      hasMore: false,
      nextOffset: null,
    })) as unknown as SessionCapability["list"];
    const deleteMany = vi.fn(async () => ({
      deleted: writerKeys,
      errors: [],
      preservedWorktrees: [],
    }));
    const sessions = createSessions({
      list,
      deleteMany,
    });
    const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions);
    const confirmation = createDeferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

    const operation = page.deleteAllArchived();
    await vi.waitFor(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    // Operator switches to `main` while the destructive confirmation sits open.
    changeScope("main");
    confirmation.resolve(true);
    await operation;

    expect(deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBeNull();
  });

  it("preserves the same-scope all-agent deleteAllArchived path", async () => {
    const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
    const list = vi.fn(async () => ({
      count: writerKeys.length,
      totalCount: writerKeys.length,
      sessions: writerKeys.map((key) => ({ key, archived: true })),
      hasMore: false,
      nextOffset: null,
    })) as unknown as SessionCapability["list"];
    const deleteMany = vi.fn(async () => ({
      deleted: writerKeys,
      errors: [],
      preservedWorktrees: [],
    }));
    const sessions = createSessions({
      list,
      deleteMany,
    });
    const { page } = await setupArchivedPageWithSelection(null, sessions);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteAllArchived();

    expect(deleteMany).toHaveBeenCalledOnce();
  });
});
