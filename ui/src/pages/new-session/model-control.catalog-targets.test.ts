import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const models: ModelCatalogEntry[] = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
];

function catalogCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(([method]) => method === "sessions.catalog.list");
}

describe("new-session CLI-agent model targets", () => {
  it("retries failed discovery with model metadata when the picker reopens", async () => {
    const { context, request } = contextWith(models, "openclaw", ["sessions.catalog.list"]);
    request.mockImplementation((method: string) => {
      if (method === "sessions.catalog.list") {
        return catalogCalls(request).length === 1
          ? Promise.reject(new Error("catalog temporarily unavailable"))
          : Promise.resolve({
              catalogs: [
                {
                  id: "anthropic",
                  label: "Claude Code",
                  capabilities: { createSession: { model: "anthropic/claude-sonnet-4-6" } },
                  hosts: [],
                },
              ],
            });
      }
      return Promise.resolve({ models });
    });
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    control.loadCatalogTargets(context, "main", true);

    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
        ),
      ).not.toBeNull(),
    );
    control.loadCatalogTargets(context, "main", true);
    await Promise.resolve();
    expect(catalogCalls(request)).toHaveLength(1);

    const picker = renderControl(control, context).querySelector<HTMLDetailsElement>(
      ".chat-controls__model-picker",
    );
    picker!.open = true;
    picker!.dispatchEvent(new Event("toggle"));

    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(2);
      expect(catalogCalls(request)).toHaveLength(2);
    });
    await vi.waitFor(() => {
      const recovered = renderControl(control, context);
      expect(recovered.querySelector('[data-chat-model-target="anthropic"]')).not.toBeNull();
      expect(
        recovered.querySelector(
          '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
        ),
      ).toBeNull();
    });

    control.loadCatalogTargets(context, "main", true);
    await Promise.resolve();
    expect(catalogCalls(request)).toHaveLength(2);
  });

  it("retries both catalogs from the visible discovery error action", async () => {
    const { context, request } = contextWith(models, "openclaw", ["sessions.catalog.list"]);
    request.mockImplementation((method: string) => {
      if (method === "sessions.catalog.list") {
        return catalogCalls(request).length === 1
          ? Promise.reject(new Error("catalog temporarily unavailable"))
          : Promise.resolve({ catalogs: [] });
      }
      return Promise.resolve({ models });
    });
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    control.loadCatalogTargets(context, "main", true);

    await vi.waitFor(() => {
      const retry = renderControl(control, context).querySelector<HTMLButtonElement>(
        '[data-chat-model-target-retry="cliAgents"]',
      );
      expect(retry).not.toBeNull();
      retry?.click();
    });

    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(2);
      expect(catalogCalls(request)).toHaveLength(2);
    });
    expect(
      renderControl(control, context).querySelector(
        '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
      ),
    ).toBeNull();
  });

  it("ignores a stale response after reconnect replaces its owner", async () => {
    const oldCatalog = deferred<{ catalogs: Array<Record<string, unknown>> }>();
    const { context: oldContext, request: oldRequest } = contextWith(models, "openclaw", [
      "sessions.catalog.list",
    ]);
    oldRequest.mockImplementation((method: string) =>
      method === "sessions.catalog.list" ? oldCatalog.promise : Promise.resolve({ models }),
    );
    const { context: newContext, request: newRequest } = contextWith(models, "openclaw", [
      "sessions.catalog.list",
    ]);
    newRequest.mockImplementation((method: string) =>
      method === "sessions.catalog.list"
        ? Promise.resolve({
            catalogs: [
              {
                id: "new-owner",
                label: "New owner",
                capabilities: { createSession: { model: "openai/gpt-5.6-luna" } },
                hosts: [],
              },
            ],
          })
        : Promise.resolve({ models }),
    );
    const control = new NewSessionModelControl(() => undefined);

    control.loadCatalogTargets(oldContext, "main", true);
    await vi.waitFor(() => expect(catalogCalls(oldRequest)).toHaveLength(1));
    control.invalidate(false);
    control.loadCatalogTargets(newContext, "main", true);

    await vi.waitFor(() =>
      expect(
        renderControl(control, newContext).querySelector('[data-chat-model-target="new-owner"]'),
      ).not.toBeNull(),
    );
    oldCatalog.resolve({
      catalogs: [
        {
          id: "stale-owner",
          label: "Stale owner",
          capabilities: { createSession: { model: "anthropic/claude-sonnet-4-6" } },
          hosts: [],
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    const container = renderControl(control, newContext);
    expect(container.querySelector('[data-chat-model-target="new-owner"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-model-target="stale-owner"]')).toBeNull();
  });
});
