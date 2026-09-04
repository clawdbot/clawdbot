import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  beginChatMetadataPublication,
  revalidateChatMetadata,
  invalidateChatMetadataStore,
  subscribeChatMetadata,
  type ChatMetadataResult,
} from "../../lib/chat/chat-metadata-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

function retainedAccountDraft() {
  const model: ModelCatalogEntry = {
    id: "model",
    name: "Model",
    provider: "anthropic",
    available: false,
    unavailableReason: "missing-auth",
  };
  const account = {
    authProfileId: "personal:person-a:anthropic:one",
    provider: "anthropic",
    label: "Saved account A1",
    authType: "token",
    selected: false,
  };
  const agent = { id: "main", model: { primary: "anthropic/model" } };
  const { context, request } = contextWith([model]);
  Object.assign(context.gateway.snapshot, { selfUser: { id: "person-a", name: "Person A" } });
  const preview = deferred<ChatMetadataResult>();
  const neutral: ChatMetadataResult = {
    commands: [],
    models: [model],
    accountSelection: { kind: "automatic", label: "Automatic" },
  };
  const connected: ChatMetadataResult = {
    commands: [],
    models: [{ ...model, available: true, unavailableReason: undefined }],
    accountSelection: {
      kind: "personal",
      authProfileId: account.authProfileId,
      label: account.label,
    },
  };
  request.mockImplementation((method: string, params: { authProfileId?: string }) => {
    if (method === "users.listModelAccounts") {
      return Promise.resolve({ profileId: "person-a", accounts: [account], links: [] });
    }
    return params.authProfileId ? preview.promise : Promise.resolve(neutral);
  });
  const savePreference = vi.fn();
  const control = new NewSessionModelControl(() => undefined, savePreference);
  control.load(context, "main", true, { agent });
  const draw = (id = "main") => renderControl(control, context, id, { ...agent, id });
  const select = (value: string) =>
    draw()
      .querySelector(".chat-model-account__picker")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
  const chooseAccount = async () => {
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    const picker = draw().querySelector(".chat-model-account__picker");
    expect(picker).not.toBeNull();
    picker!.dispatchEvent(new Event("wa-show"));
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    select(`account:${account.authProfileId}`);
    return {
      completion: revalidateChatMetadata(context.gateway.snapshot.client!, {
        agentId: "main",
        authProfileId: account.authProfileId,
      }).catch(() => undefined),
    };
  };
  return {
    account,
    agent,
    context,
    control,
    request,
    preview,
    connected,
    neutral,
    draw,
    select,
    chooseAccount,
    savePreference,
  };
}

describe("new-session model metadata lifecycle", () => {
  it("selects a retained account for an unavailable draft without changing saved preferences", async () => {
    const {
      account,
      agent,
      control,
      request,
      preview,
      connected,
      draw,
      select,
      chooseAccount,
      savePreference,
    } = retainedAccountDraft();
    const { completion } = await chooseAccount();
    expect(request).toHaveBeenLastCalledWith(
      "chat.metadata",
      { agentId: "main", authProfileId: account.authProfileId },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
    preview.resolve(connected);
    await completion;
    expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
    expect(draw().querySelector("[data-chat-account-trigger]")?.textContent).toContain(
      account.label,
    );
    expect(control.modelForSubmission()).toBe(`anthropic/model@${account.authProfileId}`);
    expect(control.selected).toBe("");
    select("automatic");
    expect(control.modelUnavailableReason(agent)).toBe("missing-auth");
    expect(control.modelForSubmission()).toBe("");
    expect(draw().querySelector("[data-chat-account-trigger]")?.textContent).toContain("Automatic");
    expect(savePreference).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(([method]) => /users\.(selectModelAccount|prefs\.set)/.test(method)),
    ).toBe(false);
    control.reset();
  });

  it.each(["request failure", "missing model", "unconfirmed account", "unknown availability"])(
    "keeps an explicit account blocked after a preview with $0",
    async (outcome) => {
      const { agent, control, preview, connected, chooseAccount } = retainedAccountDraft();
      const { completion } = await chooseAccount();
      expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
      if (outcome === "request failure") {
        preview.reject(new Error("Preview unavailable"));
      } else {
        preview.resolve({
          ...connected,
          ...(outcome === "missing model" ? { models: [] } : {}),
          ...(outcome === "unconfirmed account" ? { accountSelection: undefined } : {}),
          ...(outcome === "unknown availability"
            ? {
                models: connected.models?.map((model) =>
                  Object.assign({}, model, { available: undefined }),
                ),
              }
            : {}),
        });
      }
      await completion;
      expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable");
      control.reset();
    },
  );

  it.each(["identity", "client", "agent", "Automatic", "reset"])(
    "retires the pending account preview after changing $0",
    async (change) => {
      const { agent, context, control, preview, connected, neutral, chooseAccount, select, draw } =
        retainedAccountDraft();
      const { completion } = await chooseAccount();
      let agentId = "main";
      if (change === "identity") {
        Object.assign(context.gateway.snapshot, { selfUser: { id: "person-b", name: "Person B" } });
      } else if (change === "client") {
        Object.assign(context.gateway.snapshot, {
          client: createTestGatewayClient(async () => neutral),
        });
      } else if (change === "agent") {
        agentId = "research";
      } else if (change === "Automatic") {
        select("automatic");
      } else {
        control.reset();
      }
      control.load(context, agentId, true, { agent: { ...agent, id: agentId } });
      preview.resolve(connected);
      await completion;
      await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
      expect(control.modelForSubmission()).toBe("");
      expect(draw(agentId).querySelector("[data-chat-account-trigger]")?.textContent).toContain(
        "Automatic",
      );
      control.reset();
    },
  );

  it("retains draft model controls across client replacement but clears them for another agent", async () => {
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "openai",
      available: true,
    };
    const agent = { id: "main", model: { primary: "openai/model" } };
    const first = contextWith([model]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(first.context, "main", true, { agent });
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledOnce());
    const selection = {
      selected: "openai/model",
      contextWindow: "200k",
      thinkingLevel: "high",
      fastMode: true,
    } as const;
    Object.assign(control, selection);
    const replacement = contextWith([
      { ...model, available: false, unavailableReason: "missing-auth" },
    ]);

    control.load(replacement.context, "main", true, { agent });
    expect(control).toMatchObject(selection);
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    expect(control).toMatchObject(selection);

    control.load(replacement.context, "research", true);
    expect(control).toMatchObject({
      selected: "",
      contextWindow: "",
      thinkingLevel: "",
      fastMode: undefined,
    });
    control.reset();
  });

  it("retains its neutral auth gate through pending, rejected and failed refreshes, isolated from a session projection", async () => {
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "test",
      available: false,
      unavailableReason: "missing-auth",
    };
    const agent = { id: "main", model: { primary: "test/model" } };
    const { context, request } = contextWith([model]);
    const client = context.gateway.snapshot.client!;
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    const scope = { agentId: "main", sessionKey: "agent:main:locked" };
    const release = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish({
      commands: [],
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    expect(control.modelUnavailableReason(agent)).toBe("missing-auth");
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    request.mockReturnValueOnce(pending.promise);
    invalidateChatMetadataStore(client);
    expect(control.modelUnavailableReason(agent)).toBe("missing-auth");
    pending.resolve({ models: [{ ...model, unavailableReason: "auth-failed" }] });
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("auth-failed"));
    request.mockRejectedValueOnce(new Error("transport failed"));
    invalidateChatMetadataStore(client);
    await expect(revalidateChatMetadata(client, { agentId: "main" })).rejects.toThrow(
      "transport failed",
    );
    expect(control.modelUnavailableReason(agent)).toBe("auth-failed");
    request.mockResolvedValueOnce({
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    invalidateChatMetadataStore(client);
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBeUndefined());
    release();
    control.reset();
  });

  it("discovers account models when an operator opens the New Session picker", async () => {
    const prepared = [{ id: "prepared", name: "Prepared", provider: "openai" }];
    const discovered = [
      ...prepared,
      { id: "discovered", name: "Discovered", provider: "openai", contextWindow: 262_144 },
    ];
    const { context, request } = contextWith(prepared);
    const client = context.gateway.snapshot.client!;
    beginChatMetadataPublication(client, { agentId: "main" }).publish({
      commands: [],
      models: prepared,
    });
    request.mockImplementation((method: string) =>
      Promise.resolve({
        models: discovered,
        ...(method === "chat.metadata" ? { commands: [] } : {}),
      }),
    );
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);

    const picker = renderControl(control, context).querySelector<HTMLDetailsElement>(
      ".chat-controls__model-picker",
    );
    picker!.open = true;
    picker!.dispatchEvent(new Event("toggle"));

    await vi.waitFor(() => {
      const container = renderControl(control, context);
      expect(container.querySelector('[data-chat-model-option="openai/prepared"]')).not.toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="openai/discovered"]'),
      ).not.toBeNull();
    });
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "main",
      refresh: true,
    });
    expect(request).toHaveBeenCalledWith(
      "chat.metadata",
      { agentId: "main" },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
  });

  it("keeps a ready catalog authoritative across control teardown", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
        unavailableReason: "missing-auth",
      },
    ];
    const agent = { id: "main", model: { primary: "openai/gpt-5.6-luna" } };
    const { context, request } = contextWith(models);
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(firstControl.modelUnavailableReason(agent)).toBe("missing-auth"));
    firstControl.reset();

    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true, { agent });

    const container = renderControl(remountedControl, context, "main", agent);
    expect(container.querySelector('[data-chat-model-catalog-state="ready"]')).not.toBeNull();
    expect(remountedControl.modelUnavailableReason(agent)).toBe("missing-auth");
    expect(
      container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("No models available");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps a shared metadata request alive when its first control is torn down", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ];
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockImplementationOnce((_method, _params, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener(
        "abort",
        () => pending.reject(new DOMException("metadata request aborted", "AbortError")),
        { once: true },
      );
      return pending.promise;
    });
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstControl.reset();
    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true);
    pending.resolve({ models });

    await vi.waitFor(() => {
      const container = renderControl(remountedControl, context);
      expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
      ).not.toBeNull();
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reapplies an updated preference against the attached ready snapshot", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [{ id: "high", label: "high" }],
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [{ id: "low", label: "low" }],
      },
    ];
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    const client = context.gateway.snapshot.client!;
    beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [], models });
    request.mockReturnValueOnce(refresh.promise);
    const pendingRefresh = revalidateChatMetadata(client, { agentId: "main" });
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    expect(control.selected).toBe("openai/gpt-5.6-sol");
    expect(control.thinkingLevel).toBe("high");

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-luna", thinkingLevel: "low" },
    });

    expect(control.selected).toBe("openai/gpt-5.6-luna");
    expect(control.thinkingLevel).toBe("low");
    expect(request).toHaveBeenCalledOnce();
    refresh.resolve({ models });
    await pendingRefresh;
  });
});
