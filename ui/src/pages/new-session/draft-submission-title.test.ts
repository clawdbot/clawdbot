import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserModelAccount } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-store.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { NewSessionTitleController } from "./draft-title.ts";
import { renderControl } from "./model-control.test-support.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

function titleFixture(
  request = async (method: string, _params?: unknown): Promise<unknown> =>
    method === "sessions.title.prepare" ? { title: "Repair naming" } : {},
) {
  const fixture = createDraftFixture({
    methods: ["sessions.create", "sessions.title.prepare", "worktrees.branches"],
    scopes: ["operator.read", "operator.write", "operator.admin"],
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        workspaceGit: true,
        model: { primary: "test/primary" },
      },
    ],
    request: async (method, params) =>
      method === "worktrees.branches"
        ? { repositoryStatus: "git", branches: [], defaultBranch: "main" }
        : request(method, params),
    takePreparedTitle: () => titles.takePreparedTitle(),
  });
  const titles = new NewSessionTitleController(new TestReactiveControllerHost(), () => ({
    context: fixture.context,
    data: undefined,
    place: fixture.place,
    submission: fixture.flow,
    dictating: false,
  }));
  titles.hostConnected();
  return { ...fixture, titles };
}

function accountTitleFixture(preview?: Promise<ChatMetadataResult>) {
  const makeAccount = (id: string): UserModelAccount => ({
    authProfileId: `personal:person-a:test:${id}`,
    provider: "test",
    label: `Saved account ${id}`,
    authType: "token",
    selected: false,
  });
  const accounts: [UserModelAccount, UserModelAccount] = [makeAccount("one"), makeAccount("two")];
  const confirmed: ChatMetadataResult = {
    commands: [],
    models: [{ id: "primary", name: "Primary", provider: "test", available: true }],
    accountSelection: {
      kind: "personal",
      authProfileId: accounts[0].authProfileId,
      label: accounts[0].label,
    },
  };
  const titleRequest = vi.fn(async (_params?: unknown) => ({ title: "Prepared title" }));
  const fixture = titleFixture(async (method, params) => {
    if (method === "sessions.title.prepare") {
      return titleRequest(params);
    }
    if (method === "users.listModelAccounts") {
      return { profileId: "person-a", accounts, links: [] };
    }
    if (method === "chat.metadata") {
      const account =
        params && typeof params === "object" && "authProfileId" in params
          ? accounts.find((candidate) => candidate.authProfileId === params.authProfileId)
          : undefined;
      return account
        ? (preview ?? {
            ...confirmed,
            accountSelection: {
              kind: "personal",
              authProfileId: account.authProfileId,
              label: account.label,
            },
          })
        : {
            commands: [],
            models: confirmed.models?.map((model) =>
              Object.assign({}, model, { available: false, unavailableReason: "missing-auth" }),
            ),
            accountSelection: { kind: "automatic", label: "Automatic" },
          };
    }
    return {};
  });
  const { context, place, flow, titles } = fixture;
  Object.assign(context.gateway.snapshot, { selfUser: { id: "person-a", name: "Person A" } });
  place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
  const draw = () => renderControl(place.modelControl, context, "main", place.selectedAgent());
  const select = (value: string) =>
    draw()
      .querySelector(".chat-model-account__picker")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
  return {
    ...fixture,
    accounts,
    confirmed,
    titleRequest,
    select,
    chooseAccount: async (account: UserModelAccount) => {
      draw().querySelector(".chat-model-account__picker")!.dispatchEvent(new Event("wa-show"));
      await vi.advanceTimersByTimeAsync(0);
      expect(draw().textContent).toContain(account.label);
      select(`account:${account.authProfileId}`);
      await vi.advanceTimersByTimeAsync(0);
    },
    dispose: () => {
      titles.hostDisconnected();
      place.modelControl.reset();
      flow.disconnect();
    },
  };
}

describe("prepared title creation handoff", () => {
  it("keeps title preparation and creation on the selected draft account", async () => {
    const fixture = accountTitleFixture();
    const { accounts, context, flow, place, titles, titleRequest, chooseAccount } = fixture;
    try {
      titleRequest
        .mockResolvedValueOnce({ title: "Automatic title" })
        .mockResolvedValueOnce({ title: "First account title" })
        .mockResolvedValueOnce({ title: "Second account title" });
      flow.setMessage("repair the sidebar naming");
      titles.hostUpdated();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(titles.preparedTitle()).toBe("Automatic title");

      for (const [index, account] of accounts.entries()) {
        await chooseAccount(account);
        expect(titles.preparedTitle()).toBeUndefined();
        titles.hostUpdated();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(titleRequest).toHaveBeenLastCalledWith({
          agentId: "main",
          message: flow.message,
          model: `test/primary@${account.authProfileId}`,
        });
        expect(titles.preparedTitle()).toBe(
          index === 0 ? "First account title" : "Second account title",
        );
      }
      expect(place.modelControl.selected).toBe("");
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Second account title",
          model: `test/primary@${accounts[1].authProfileId}`,
        }),
        { reconciliation: "background" },
      );
    } finally {
      fixture.dispose();
    }
  });

  it.each(["pending", "unconfirmed", "different provider"])(
    "pauses personal title inference for a %s preview without disabling ordinary naming",
    async (outcome) => {
      const preview = createDeferred<ChatMetadataResult>();
      const fixture = accountTitleFixture(preview.promise);
      const { accounts, confirmed, flow, titles, titleRequest, chooseAccount, select } = fixture;
      try {
        flow.setMessage("repair the sidebar naming");
        titles.hostUpdated();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(titleRequest).toHaveBeenCalledOnce();
        await chooseAccount(accounts[0]);
        if (outcome !== "pending") {
          preview.resolve({
            ...confirmed,
            ...(outcome === "unconfirmed"
              ? {
                  accountSelection: {
                    kind: "personal",
                    authProfileId: accounts[1].authProfileId,
                    label: accounts[1].label,
                  },
                }
              : {
                  models: confirmed.models?.map((model) =>
                    Object.assign({}, model, { provider: "other" }),
                  ),
                }),
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        titles.hostUpdated();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(titles.preparedTitle()).toBeUndefined();
        expect(titleRequest).toHaveBeenCalledOnce();

        select("automatic");
        titles.hostUpdated();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(titleRequest).toHaveBeenCalledTimes(2);
        expect(titles.preparedTitle()).toBe("Prepared title");
      } finally {
        preview.resolve(confirmed);
        fixture.dispose();
      }
    },
  );

  it("uses a ready title at creation without changing an explicit worktree name", async () => {
    const { flow, context, place, titles } = titleFixture();
    place.toggleWorktree();
    place.setWorktreeName("my-explicit-branch");
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Repair naming", worktreeName: "my-explicit-branch" }),
      { reconciliation: "background" },
    );
    titles.hostDisconnected();
    flow.disconnect();
  });

  it("sends immediately while preparation is pending and ignores its late result", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const { flow, context, titles } = titleFixture(async (method) =>
      method === "sessions.title.prepare" ? pending : {},
    );
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(
      "displayName",
    );
    finish({ title: "Too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(titles.preparedTitle()).toBeUndefined();
    titles.hostDisconnected();
    flow.disconnect();
  });

  it("never sends an incognito draft and discards an earlier normal suggestion", async () => {
    const { flow, request, context, titles } = titleFixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    flow.setVisibility("incognito");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
    ).toHaveLength(1);
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).toMatchObject({
      incognito: true,
    });
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(
      "displayName",
    );
    titles.hostDisconnected();
    flow.disconnect();
  });

  it("does not restart speculation when a submitted draft is retried", async () => {
    const { flow, request, titles } = titleFixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    await flow.submit();
    await flow.submit();
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
    ).toHaveLength(1);
    titles.hostDisconnected();
    flow.disconnect();
  });

  it("rejects a stale title even when Send beats the next UI update", async () => {
    const { flow, context, titles } = titleFixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    flow.setMessage("investigate a different reconnect bug");
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(
      "displayName",
    );
    titles.hostDisconnected();
    flow.disconnect();
  });
});
