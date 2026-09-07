/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelsAuthLogoutParams,
  ModelsAuthOrderSetParams,
} from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ModelAuthStatusProfile } from "../../api/types.ts";
import {
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../../test-helpers/modal-dialog.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  deferred,
  requestCount,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage profile actions", () => {
  it.each([
    { name: "reorder", profileIds: ["openai:two", "openai:one"] },
    { name: "Reset", profileIds: null },
  ])("refreshes uncertain status after a committed $name", async ({ profileIds }) => {
    const shell = document.createElement("div");
    shell.className = "shell";
    document.body.append(shell);
    const toast = shell.appendChild(document.createElement("openclaw-toast-host"));
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const originalRequest = request.getMockImplementation()!;
    const warning = "Profile priority saved, but live authentication status could not refresh.";
    let committed = false;
    request.mockImplementation(async (method: string) => {
      if (method === "models.authOrderSet") {
        committed = true;
        return { provider: "openai", profileIds, warning };
      }
      if (method === "models.authStatus") {
        return committed
          ? {
              ts: 2,
              providers: [],
              unavailable: {
                code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
                message: "Account status unavailable",
              },
            }
          : createAuthStatus([
              {
                profileOrder: ["openai:one", "openai:two"],
                profileOrderStored: true,
              },
            ]);
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    await waitForFast(() =>
      expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2),
    );

    page.profileActions.setOrder("openai", "openai", profileIds);

    await waitForFast(() =>
      expect(page.data?.authStatus?.unavailable?.code).toBe("PREPARED_MODEL_AUTH_UNAVAILABLE"),
    );
    await waitForFast(() => expect(toast.textContent).toContain(warning));
    expect(page.profileOrders.openai).toBeUndefined();
    expect(page.data?.authStatus?.providers).toEqual([]);
    expect(page.querySelector(".model-providers__profile")).toBeNull();
  });

  it("keeps the latest queued order through paused and resumed configuration work", async () => {
    const { context, notifyRuntimeConfig, request, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet" && requestCount(request, method) === 1) {
        return firstSave.promise;
      }
      void params;
      return originalRequest(method);
    });

    page.profileActions.setOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    page.profileActions.setOrder("openai", "openai", ["openai:one", "openai:two"]);
    expect(page.profileOrders.openai).toEqual(["openai:one", "openai:two"]);
    expect(requestCount(request, "models.authOrderSet")).toBe(1);
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    firstSave.resolve({});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(requestCount(request, "models.authOrderSet")).toBe(1);
    expect(page.profileOrders.openai).toEqual(["openai:one", "openai:two"]);

    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(2));
    await vi.waitFor(() => expect(page.profileOrders.openai).toBeUndefined());
    expect(request.mock.calls.findLast(([method]) => method === "models.authOrderSet")).toEqual([
      "models.authOrderSet",
      { provider: "openai", profileIds: ["openai:one", "openai:two"], agentId: "main" },
    ]);
    expect(page.messages.openai).toBeUndefined();
  });

  it("discards a detached page's queued order before a replacement page saves", async () => {
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    let savedOrder = ["openai:one", "openai:two", "openai:three"];
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet") {
        savedOrder = [...((params as ModelsAuthOrderSetParams).profileIds ?? [])];
        return requestCount(request, method) === 1 ? firstSave.promise : {};
      }
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            profiles: ["openai:one", "openai:two", "openai:three"].map((profileId) => ({
              profileId,
              type: "oauth",
              status: "ok",
            })),
            profileOrder: [...savedOrder],
            profileOrderStored: true,
          },
        ]);
      }
      return originalRequest(method);
    });
    const rows = (page: HTMLElement) =>
      [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      );
    const moveFirstAccount = (page: HTMLElement, direction: "up" | "down") => {
      const grip = page.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:one"] .model-providers__profile-grip',
      )!;
      expect(grip.disabled).toBe(false);
      grip.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: direction === "up" ? "ArrowUp" : "ArrowDown",
          bubbles: true,
        }),
      );
    };
    const oldPage = appendPage(context);
    await waitForFast(() => expect(rows(oldPage)).toHaveLength(3));
    moveFirstAccount(oldPage, "down");
    await oldPage.updateComplete;
    moveFirstAccount(oldPage, "down");
    await oldPage.updateComplete;
    expect(rows(oldPage)).toEqual(["openai:two", "openai:three", "openai:one"]);
    expect(requestCount(request, "models.authOrderSet")).toBe(1);

    oldPage.remove();
    const replacementPage = appendPage(context);
    await waitForFast(() =>
      expect(rows(replacementPage)).toEqual(["openai:two", "openai:one", "openai:three"]),
    );
    moveFirstAccount(replacementPage, "up");
    await waitForFast(() => expect(replacementPage.profileOrders.openai).toBeUndefined());
    expect(savedOrder).toEqual(["openai:one", "openai:two", "openai:three"]);

    // The first write already reached the server; only its response is delayed.
    // Let its continuation finish before checking for an obsolete queued write.
    firstSave.resolve({});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(savedOrder).toEqual(["openai:one", "openai:two", "openai:three"]);
    expect(requestCount(request, "models.authOrderSet")).toBe(2);
    expect(rows(replacementPage)).toEqual(["openai:one", "openai:two", "openai:three"]);
  });

  it("keeps a saved auth-owner order on every alias route", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      authStatus: createAuthStatus([
        ...["claude-cli", "anthropic"].map((provider) => ({
          provider,
          authProvider: "anthropic",
          displayName: "Claude",
          profiles: [
            { profileId: "claude:one", type: "oauth" as const, status: "ok" as const },
            { profileId: "claude:two", type: "oauth" as const, status: "ok" as const },
          ],
          profileOrder: ["claude:one", "claude:two"],
        })),
        { profileOrder: ["openai:one", "openai:two"] },
      ]),
      updatedAt: 1,
    };
    const unrelatedProvider = structuredClone(page.data.authStatus?.providers[2]);

    page.profileActions.setOrder("anthropic", "anthropic", ["claude:two", "claude:one"]);

    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(page.profileOrders.anthropic).toBeUndefined());
    expect(
      page.data.authStatus?.providers.map(({ provider, profileOrder }) => ({
        provider,
        profileOrder,
      })),
    ).toEqual([
      { provider: "claude-cli", profileOrder: ["claude:two", "claude:one"] },
      { provider: "anthropic", profileOrder: ["claude:two", "claude:one"] },
      { provider: "openai", profileOrder: ["openai:one", "openai:two"] },
    ]);
    expect(page.data.authStatus?.providers[2]).toEqual(unrelatedProvider);
  });

  it("keeps a saved profile order when an older refresh finishes afterward", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    const staleStatus = deferred<unknown>();
    const authStatus = createAuthStatus([
      {
        profileOrder: ["openai:one", "openai:two"],
      },
    ]);
    const refreshedStatus = {
      ...authStatus,
      ts: 2,
      providers: [
        {
          ...authStatus.providers[0],
          profileOrder: ["openai:two", "openai:one"],
        },
      ],
    };
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      authStatus,
      updatedAt: 1,
    };
    request.mockClear();
    let authStatusCalls = 0;
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authStatus") {
        authStatusCalls += 1;
        return authStatusCalls === 1 ? staleStatus.promise : refreshedStatus;
      }
      if (method === "models.authOrderSet") {
        return {};
      }
      void params;
      return originalRequest(method);
    });

    const refreshing = page.refresh({ force: true });
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(1));
    page.profileActions.setOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(authStatusCalls).toBe(2));
    await vi.waitFor(() => expect(page.profileOrders.openai).toBeUndefined());
    expect(page.data.authStatus?.providers[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);

    staleStatus.resolve(authStatus);
    await refreshing;

    expect(page.data.authStatus?.providers[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);
  });

  it("cancels safely and logs out only the confirmed account's credential owner", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const { agentSelection, context, notifySelection, publishPhase, request, snapshot } =
      createHarness("writer");
    snapshot.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const originalRequest = request.getMockImplementation()!;
    const logout = deferred<void>();
    let failLogout = true;
    let profiles: ModelAuthStatusProfile[] = [
      {
        profileId: "work",
        type: "oauth",
        status: "ok",
        email: "work@example.com",
        logoutSupported: true,
      },
      {
        profileId: "personal",
        type: "oauth",
        status: "ok",
        email: "personal@example.com",
        logoutSupported: true,
      },
    ];
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            provider: "claude-cli",
            authProvider: "anthropic",
            displayName: "Claude",
            profiles,
          },
        ]);
      }
      if (method === "models.authLogout") {
        if (failLogout) {
          failLogout = false;
          throw new Error("The account could not be logged out");
        }
        await logout.promise;
        const { profileIds } = params as ModelsAuthLogoutParams;
        profiles = profiles.filter((profile) => !profileIds?.includes(profile.profileId));
        return {};
      }
      return originalRequest(method);
    });
    const shell = document.body.appendChild(document.createElement("div"));
    shell.className = "shell";
    const toast = shell.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    try {
      const openConfirmation = async () => {
        // Separate user clicks so the previous confirmation can settle.
        await nextFrame();
        await waitForFast(() =>
          expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2),
        );
        page.querySelector<HTMLButtonElement>('[aria-label="Log out work@example.com"]')!.click();
        await page.updateComplete;
        return getRenderedModalDialog(document.body);
      };
      const { modal: initialModal, dialog } = await openConfirmation();
      let modal = initialModal;
      expect(page.contains(modal)).toBe(false);
      expect(dialog.getAttribute("aria-label")).toBe("Log out work@example.com");
      expect(modal.textContent).toContain("work@example.com");
      expect(requestCount(request, "models.authLogout")).toBe(0);
      modal.querySelector<HTMLButtonElement>("button[autofocus]")!.click();
      await page.updateComplete;
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(requestCount(request, "models.authLogout")).toBe(0);

      for (const invalidate of [
        () => {
          agentSelection.state.selectedId = "main";
          notifySelection();
        },
        () => publishPhase("connecting"),
        () => page.remove(),
      ]) {
        ({ modal } = await openConfirmation());
        const confirm = modal.querySelector<HTMLButtonElement>("button.danger")!;
        invalidate();
        await waitForFast(() =>
          expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
        );
        confirm.click();
        expect(requestCount(request, "models.authLogout")).toBe(0);
        agentSelection.state.selectedId = "writer";
        notifySelection();
        publishPhase("connected");
        if (!page.isConnected) {
          document.body.append(page);
        }
        await page.updateComplete;
      }

      ({ modal } = await openConfirmation());
      modal.querySelector<HTMLButtonElement>("button.danger")!.click();
      await waitForFast(() =>
        expect(toast.textContent).toContain("The account could not be logged out"),
      );
      expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2);
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(page.querySelector(".model-providers__row > .callout")).toBeNull();
      expect(page.messages.anthropic).toBeUndefined();
      expect(requestCount(request, "models.authLogout")).toBe(1);

      ({ modal } = await openConfirmation());
      expect(modal.querySelector('[role="alert"]')).toBeNull();
      modal.querySelector<HTMLButtonElement>("button.danger")!.click();
      await waitForFast(() => expect(requestCount(request, "models.authLogout")).toBe(2));
      await page.updateComplete;
      expect(request).toHaveBeenCalledWith("models.authLogout", {
        provider: "claude-cli",
        profileIds: ["work"],
        agentId: "writer",
      });
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(
        [...page.querySelectorAll<HTMLButtonElement>(".model-providers__profile-logout")].every(
          (button) => button.disabled,
        ),
      ).toBe(true);
      logout.resolve();
      await waitForFast(() =>
        expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(1),
      );
      expect(requestCount(request, "models.authLogout")).toBe(2);
      expect(
        [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
          (row) => row.dataset.profileId,
        ),
      ).toEqual(["personal"]);
      await toast.updateComplete;
      expect(toast.isConnected).toBe(true);
      expect(toast.parentElement).toBe(shell);
      expect(toast.querySelector(".app-toast--bottom .app-toast__icon")).not.toBeNull();
      expect(toast.querySelector('[role="status"]')?.textContent).toContain("Logged out.");
      expect(page.querySelector(".model-providers__row > .callout")).toBeNull();
      expect(page.messages.anthropic).toBeUndefined();
    } finally {
      logout.resolve();
      page.remove();
      restoreDialogPolyfill();
    }
  });
});
