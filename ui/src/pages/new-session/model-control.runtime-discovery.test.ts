import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  gatewayStartupUnavailableDetails,
} from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { loadModels } from "../../lib/chat/model-catalog-store.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

describe("new-session runtime discovery", () => {
  it("keeps prepared rows when readiness fails before the prepared read", async () => {
    const prepared = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request
      .mockReturnValueOnce(prepared.promise)
      .mockRejectedValueOnce(new Error("runtime discovery failed"));
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-catalog-state="error"]'),
      ).not.toBeNull(),
    );
    prepared.resolve({
      models: [{ id: "static", name: "Static", provider: "omniroute" }],
    });

    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-option="omniroute/static"]',
        ),
      ).not.toBeNull(),
    );
    expect(renderControl(control, context).textContent).not.toContain("Models unavailable");
  });

  it("keeps New Session pending until post-ready discovery publishes", async () => {
    const refreshedPreparedModel: ModelCatalogEntry = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "omniroute",
      reasoning: true,
      thinkingDefault: "high",
      thinkingLevels: ["off", "low", "medium", "high", "xhigh"].map((id) => ({
        id,
        label: id,
      })),
    };
    const staticPreparedModel: ModelCatalogEntry = {
      id: "static",
      name: "Static",
      provider: "omniroute",
    };
    const { context, request } = contextWith([staticPreparedModel]);
    const client = context.gateway.snapshot?.client;
    if (!client) {
      throw new Error("connected test context omitted its client");
    }
    await loadModels(client, { agentId: "main", preparedOnly: true });
    const retry = deferred<{ models: ModelCatalogEntry[] }>();
    const pending = Object.assign(new Error("runtime discovery pending"), {
      code: "UNAVAILABLE",
      details: gatewayStartupUnavailableDetails(),
      retryAfterMs: 100,
      retryable: true,
    });
    request.mockRejectedValueOnce(pending).mockReturnValueOnce(retry.promise);
    const control = new NewSessionModelControl(() => undefined);
    const agent = {
      id: "main",
      model: { primary: "omniroute/deepseek-v4-flash" },
      thinkingLevels: ["off", "low", "medium", "high"].map((id) => ({ id, label: id })),
    };

    control.load(context, "main", true, { agent });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(
      renderControl(control, context).querySelector('[data-chat-model-option="omniroute/static"]'),
    ).not.toBeNull();
    const expectedRequest = [
      "models.list",
      {
        agentId: "main",
        preparedOnly: true,
        view: "configured",
        waitForRuntimeDiscovery: true,
      },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    ] as const;
    expect(request).toHaveBeenCalledWith(...expectedRequest);
    expect(request.mock.calls.some(([method]) => method === "chat.metadata")).toBe(false);
    expect(request).toHaveBeenLastCalledWith(...expectedRequest);

    retry.resolve({ models: [refreshedPreparedModel] });
    await vi.waitFor(() =>
      expect(
        renderControl(control, context, "main", agent).querySelector(
          '[data-chat-model-option="omniroute/deepseek-v4-flash"]',
        ),
      ).not.toBeNull(),
    );
    await vi.waitFor(() =>
      expect(
        renderControl(control, context, "main", agent)
          .querySelector('[data-chat-thinking-slider="true"]')
          ?.getAttribute("data-chat-thinking-values"),
      ).toBe("off,low,medium,high,xhigh"),
    );
  });
});
