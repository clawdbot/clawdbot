import { render, type ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ModelProviderLoginController } from "./login-controller.ts";

const XAI_LOGIN_OPTION = { id: "xai-oauth", label: "xAI OAuth", mode: "login" } as const;
const VLLM_SETUP_OPTION = { id: "vllm", label: "vLLM", mode: "setup" } as const;

function createRuntimeConfig(client: GatewayBrowserClient) {
  return {
    runExternalMutation: vi.fn(async (task) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: true as const },
    })),
  } satisfies Pick<RuntimeConfigCapability, "runExternalMutation">;
}

describe("ModelProviderLoginController", () => {
  it("cancels an admitted Gateway wizard on reset before another login starts", async () => {
    let runningSessionId: string | null = null;
    let starts = 0;
    let confirmRelease!: () => void;
    const releaseConfirmed = new Promise<void>((resolve) => {
      confirmRelease = resolve;
    });
    const request = vi.fn(
      async (method: string, params?: { sessionId?: string }): Promise<unknown> => {
        if (method === "openclaw.setup.auth.start") {
          if (runningSessionId) {
            throw new Error("wizard already running");
          }
          starts += 1;
          if (starts === 1) {
            runningSessionId = `login-${starts}`;
            return { sessionId: runningSessionId, done: false, status: "running" };
          }
          return { sessionId: `login-${starts}`, done: true, status: "done" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: {
              id: "device-code",
              type: "note",
              executor: "client",
              message: "Continue in the provider browser.",
            },
          };
        }
        if (method === "wizard.cancel") {
          expect(params?.sessionId).toBe(runningSessionId);
          return { status: "cancelled" };
        }
        if (method === "wizard.status") {
          expect(params?.sessionId).toBe(runningSessionId);
          await releaseConfirmed;
          runningSessionId = null;
          return { status: "cancelled" };
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const host = {
      addController: vi.fn(),
      requestUpdate: vi.fn(),
    } as unknown as ReactiveControllerHost;
    const refresh = vi.fn(async () => undefined);
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new ModelProviderLoginController(host, {
      getClient: () => client,
      getAgentId: () => "main",
      getRuntimeConfig: () => createRuntimeConfig(client),
      canStart: () => true,
      refresh,
      setMessage: vi.fn(),
    });

    controller.start("xai", XAI_LOGIN_OPTION);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("wizard.next", expect.anything(), expect.anything()),
    );
    expect(runningSessionId).not.toBeNull();

    controller.reset();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: expect.any(String) },
        { timeoutMs: 30_000 },
      ),
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.status",
        { sessionId: expect.any(String) },
        { timeoutMs: 30_000 },
      ),
    );
    controller.start("xai", XAI_LOGIN_OPTION);
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(controller.busy).toBe(true);

    confirmRelease();
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    controller.start("xai", XAI_LOGIN_OPTION);
    await vi.waitFor(() => expect(starts).toBe(2));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("keeps sign-in busy until a commit-locked login releases admission", async () => {
    let running = true;
    let starts = 0;
    const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
      if (method === "openclaw.setup.auth.start") {
        starts += 1;
        if (starts > 1 && running) {
          throw new Error("wizard already running");
        }
        return { sessionId: `login-${starts}`, done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "device-code", type: "note", executor: "client" },
        };
      }
      if (method === "wizard.cancel") {
        return { status: running ? "running" : "done" };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const host = {
      addController: vi.fn(),
      requestUpdate: vi.fn(),
    } as unknown as ReactiveControllerHost;
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new ModelProviderLoginController(host, {
      getClient: () => client,
      getAgentId: () => "main",
      getRuntimeConfig: () => createRuntimeConfig(client),
      canStart: () => true,
      refresh: vi.fn(async () => undefined),
      setMessage: vi.fn(),
    });

    controller.start("xai", XAI_LOGIN_OPTION);
    await vi.waitFor(() => expect(starts).toBe(1));
    controller.reset();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: expect.any(String) },
        { timeoutMs: 30_000 },
      ),
    );

    controller.start("xai", XAI_LOGIN_OPTION);
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toHaveLength(2),
    );
    expect(starts).toBe(1);
    expect(controller.busy).toBe(true);

    running = false;
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    controller.start("xai", XAI_LOGIN_OPTION);
    await vi.waitFor(() => expect(starts).toBe(2));
  });

  it("routes provider setup choices through the shared prepare wizard", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: params?.sessionId, done: true, status: "done" };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const setMessage = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new ModelProviderLoginController(
      { addController: vi.fn(), requestUpdate: vi.fn() } as unknown as ReactiveControllerHost,
      {
        getClient: () => client,
        getAgentId: () => "main",
        getRuntimeConfig: () => createRuntimeConfig(client),
        canStart: () => true,
        refresh: vi.fn(async () => undefined),
        setMessage,
      },
    );

    controller.start("vllm", VLLM_SETUP_OPTION);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.prepare.start",
        expect.objectContaining({ agentId: "main", authChoice: "vllm" }),
        { timeoutMs: null },
      ),
    );
    await vi.waitFor(() =>
      expect(setMessage).toHaveBeenCalledWith("vllm", {
        kind: "success",
        text: "Configured",
      }),
    );
  });

  it("coordinates provider login start and answer with config mutations", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "coordinated-login", done: false, status: "running" };
      }
      if (method === "wizard.next" && !params?.answer) {
        return {
          done: false,
          status: "running",
          step: { id: "confirm", type: "confirm", message: "Continue?", executor: "client" },
        };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runtimeConfig = createRuntimeConfig(client);
    const controller = new ModelProviderLoginController(
      { addController: vi.fn(), requestUpdate: vi.fn() } as unknown as ReactiveControllerHost,
      {
        getClient: () => client,
        getAgentId: () => "main",
        getRuntimeConfig: () => runtimeConfig,
        canStart: () => true,
        refresh: vi.fn(async () => undefined),
        setMessage: vi.fn(),
      },
    );

    controller.start("xai", XAI_LOGIN_OPTION);
    await vi.waitFor(() => expect(runtimeConfig.runExternalMutation).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.next",
        expect.objectContaining({ sessionId: expect.any(String) }),
        expect.anything(),
      ),
    );
    const container = document.createElement("div");
    render(controller.render(), container);
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Yes",
    );
    expect(confirm).toBeDefined();

    confirm?.click();

    await vi.waitFor(() => expect(runtimeConfig.runExternalMutation).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.next",
        expect.objectContaining({
          sessionId: expect.any(String),
          answer: { stepId: "confirm", value: true },
        }),
        expect.anything(),
      ),
    );
  });

  it("renders setup choices with prepare-mode copy", () => {
    const request = vi.fn(async (_method: string, params?: { sessionId?: string }) => ({
      sessionId: params?.sessionId,
      done: true,
      status: "done",
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new ModelProviderLoginController(
      { addController: vi.fn(), requestUpdate: vi.fn() } as unknown as ReactiveControllerHost,
      {
        getClient: () => client,
        getAgentId: () => "main",
        getRuntimeConfig: () => createRuntimeConfig(client),
        canStart: () => true,
        refresh: vi.fn(async () => undefined),
        setMessage: vi.fn(),
      },
    );

    controller.start("vllm", VLLM_SETUP_OPTION);
    const container = document.createElement("div");
    render(controller.render(), container);

    expect(container.querySelector("openclaw-modal-dialog")?.getAttribute("label")).toBe(
      "Local model setup",
    );
    expect(container.textContent).toContain("Starting local model setup…");
  });
});
