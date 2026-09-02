import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  beginChatMetadataPublication,
  revalidateChatMetadata,
  invalidateChatMetadataStore,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

describe("new-session model metadata lifecycle", () => {
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
