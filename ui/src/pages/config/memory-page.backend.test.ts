/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { configRouteData } from "./route-data.ts";
import "./memory-page.ts";

type MemoryPageElement = HTMLElement & {
  configObject: Record<string, unknown>;
  routeData: ReturnType<typeof configRouteData>;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("MemorySettingsPage backend repair", () => {
  it("removes a malformed explicit backend through the curated reset action", async () => {
    const removeFormValue = vi.fn();
    const subscribe = () => () => undefined;
    const request = vi.fn((method: string) => {
      if (method === "plugins.list") {
        return Promise.resolve({
          plugins: [
            {
              id: "memory-core",
              name: "memory-core",
              installed: true,
              enabled: true,
              state: "enabled",
              kind: ["memory"],
            },
          ],
          diagnostics: [],
          mutationAllowed: true,
        });
      }
      return Promise.resolve({});
    });
    const context = {
      basePath: "",
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: { auth: { role: "operator", scopes: ["operator.admin"] }, features: {} },
        },
        subscribe,
      },
      runtimeConfig: {
        state: {
          client: {},
          connected: true,
          configSaving: false,
          configApplying: false,
          configForm: { memory: { backend: "retired-backend" } },
          configSnapshot: null,
        },
        subscribe,
        lookupSchemaPath: vi.fn(async () => ({ type: "object" })),
        patchForm: vi.fn(),
        removeFormValue,
        waitForPendingWrites: vi.fn(async () => undefined),
        refresh: vi.fn(async () => undefined),
        ensureLoaded: vi.fn(async () => undefined),
      },
      agents: {
        state: {
          agentsList: { defaultId: "main", agents: [{ id: "main" }] },
          agentsLoading: false,
        },
        subscribe,
        ensureList: vi.fn(async () => undefined),
      },
      navigate: vi.fn(),
      replace: vi.fn(),
    } as unknown as ApplicationContext;
    const element = document.createElement("openclaw-memory-settings") as MemoryPageElement;
    element.configObject = { memory: { backend: "retired-backend" } };
    element.routeData = configRouteData({
      pathname: "/settings/memory/settings",
      search: "",
      hash: "",
    });
    (element as unknown as { context: ApplicationContext }).context = context;
    const provider = new ContextProvider(element, {
      context: applicationContext,
      initialValue: context,
    });
    provider.setValue(context);
    document.body.append(element);

    await waitForFast(() => expect(element.textContent).toContain("Invalid configured value"));
    const backendRow = [...element.querySelectorAll(".settings-row")].find((row) =>
      row.textContent?.includes("Retrieval backend"),
    );

    backendRow?.querySelector<HTMLButtonElement>('button[aria-label="Reset to default"]')?.click();

    expect(removeFormValue).toHaveBeenCalledWith(["memory", "backend"]);
  });
});
