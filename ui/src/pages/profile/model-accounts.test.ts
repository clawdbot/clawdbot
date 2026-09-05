/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersListModelAccountsResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ModelAccounts } from "./model-accounts.ts";

const TEST_TAG = "test-openclaw-model-accounts";
if (!customElements.get(TEST_TAG)) {
  customElements.define(TEST_TAG, class extends ModelAccounts {});
}

const connectedResult: UsersAuthConnectStatusResult = {
  status: "connected",
  authProfileId: "openai:personal",
  links: [{ provider: "openai", authProfileId: "openai:personal", updatedAt: 1 }],
};

const connectedAccount: UserModelAccount = {
  authProfileId: "openai:personal",
  provider: "openai",
  label: "Ada · Personal workspace",
  authType: "oauth",
  selected: true,
};
const claudeAccount: UserModelAccount = {
  authProfileId: "anthropic:personal",
  provider: "anthropic",
  label: "Ada · Claude",
  authType: "api_key",
  selected: true,
};
const catalog: UsersAuthConnectCatalogResult = {
  providers: [
    { id: "openai", label: "OpenAI", methods: [{ id: "browser", label: "Browser sign-in" }] },
    { id: "anthropic", label: "Anthropic", methods: [{ id: "api-key", label: "API key" }] },
    { id: "xai", label: "Grok", methods: [{ id: "api-key", label: "API key" }] },
  ],
};
const redirectStep = (attempt = 1): WizardStep => ({
  id: `redirect-${attempt}`,
  type: "text",
  message: "Paste the redirect URL or wait for sign-in to finish.",
  externalUrl: `https://auth.openai.com/oauth/authorize?state=${attempt}`,
});

async function mountAccounts(
  handle: (
    method: string,
    params?: unknown,
  ) => Promise<UsersAuthConnectStatusResult | UsersListAuthLinksResult>,
  {
    expiresInMs = 60_000,
    scopes = ["operator.write"],
    accounts: initialAccounts = [],
    inventoryPages,
    gatewayUrl,
    step,
    connectedAccounts = [connectedAccount, claudeAccount],
  }: {
    expiresInMs?: number;
    scopes?: string[];
    accounts?: UserModelAccount[];
    inventoryPages?: UsersListModelAccountsResult[];
    gatewayUrl?: string;
    step?: WizardStep;
    connectedAccounts?: UserModelAccount[];
  } = {},
) {
  let starts = 0;
  let savedAccounts = initialAccounts;
  let links: UserProfileAuthLink[] = savedAccounts
    .filter((account) => account.selected)
    .map((account) => ({
      provider: account.provider,
      authProfileId: account.authProfileId,
      updatedAt: 1,
    }));
  let inventoryPage = 0;
  const fixtures = [
    ...savedAccounts,
    ...(inventoryPages?.flatMap((page) => page.accounts) ?? []),
    ...connectedAccounts,
  ];
  const presented = new Set<string>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.authConnect.catalog") {
      return catalog;
    }
    if (method === "users.listModelAccounts") {
      const page = inventoryPages?.[inventoryPage++];
      if (page) {
        savedAccounts = [
          ...new Map(
            [...savedAccounts, ...page.accounts].map((account) => [account.authProfileId, account]),
          ).values(),
        ];
        links = page.links;
      }
      return page ?? { profileId: "profile-1", accounts: savedAccounts, links };
    }
    if (method === "users.authConnect.start") {
      starts += 1;
      return {
        connectId: `connect-${starts}`,
        expiresAtMs: Date.now() + expiresInMs,
      };
    }
    if (method === "users.authConnect.status" && !presented.has(`connect-${starts}`)) {
      presented.add(`connect-${starts}`);
      return { status: "pending", step: step ?? redirectStep(starts) };
    }
    const result = await handle(method, params);
    if ("links" in result) {
      links = result.links;
      const saved = new Map(savedAccounts.map((account) => [account.authProfileId, account]));
      for (const link of links) {
        const account = fixtures.find(
          (candidate) => candidate.authProfileId === link.authProfileId,
        );
        if (account) {
          saved.set(account.authProfileId, account);
        }
      }
      savedAccounts = [...saved.values()].map((account) =>
        Object.assign({}, account, {
          selected: links.some((link) => link.authProfileId === account.authProfileId),
        }),
      );
    }
    return result;
  });
  const client = createTestGatewayClient(request);
  if (gatewayUrl) {
    vi.spyOn(client, "gatewayUrl", "get").mockReturnValue(gatewayUrl);
  }
  let snapshot = {
    client,
    phase: "connected",
    hello: { auth: { role: "operator", scopes } },
    selfUser: { id: "profile-1", name: "Ada" },
  } as ApplicationGatewaySnapshot;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const context = {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const accounts = document.createElement(TEST_TAG) as ModelAccounts;
  accounts.identityId = "profile-1";
  accounts.profileId = "profile-1";
  provider.append(accounts);
  document.body.append(provider);
  await vi.waitFor(() =>
    expect(button(accounts, ".profile-auth-add-account").disabled).toBe(false),
  );
  return {
    accounts,
    request,
    async start(providerId = "openai") {
      button(accounts, ".profile-auth-add-account").click();
      await vi.waitFor(() =>
        expect(
          accounts.querySelector(`.profile-auth-provider wa-option[value="${providerId}"]`),
        ).not.toBeNull(),
      );
      await select(accounts, ".profile-auth-provider", providerId);
      button(accounts, ".profile-auth-connect-start").click();
      await vi.waitFor(() => expect(accounts.querySelector(".model-accounts-flow")).not.toBeNull());
      await vi.advanceTimersByTimeAsync(0);
      await accounts.updateComplete;
    },
    emit(phase: ApplicationGatewaySnapshot["phase"]) {
      snapshot = { ...snapshot, phase };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function button(root: ParentNode, selector: string) {
  const element = root.querySelector<HTMLButtonElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

async function input(accounts: ModelAccounts, selector: string, value: string) {
  const element = accounts.querySelector<HTMLInputElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  await accounts.updateComplete;
  return element;
}

async function select(accounts: ModelAccounts, selector: string, value: string) {
  const element = accounts.querySelector<HTMLElement & { value: string }>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await accounts.updateComplete;
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("lets a writer choose a retained account for new chats and clear the default without removing it", async () => {
  const work = {
    ...connectedAccount,
    authProfileId: "openai:work",
    label: "Ada · Work workspace",
    selected: false,
  };
  const harness = await mountAccounts(
    async (method, params) => {
      if (method === "users.selectModelAccount") {
        expect(params).toEqual({ profileId: "profile-1", authProfileId: work.authProfileId });
        return { links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 2 }] };
      }
      expect(method).toBe("users.unlinkAuthProfile");
      expect(params).toEqual({ profileId: "profile-1", provider: "openai" });
      return { links: [] };
    },
    { accounts: [connectedAccount, work] },
  );
  expect(harness.accounts.querySelector(".profile-auth-link-input")).toBeNull();
  expect(harness.accounts.textContent).toContain(connectedAccount.label);
  expect(harness.accounts.textContent).toContain(work.label);
  expect(harness.accounts.textContent).not.toContain(work.authProfileId);
  button(harness.accounts, `[data-auth-profile-id="${work.authProfileId}"]`).click();
  await vi.waitFor(() =>
    expect(harness.accounts.textContent).toContain(t("profilePage.modelAccounts.notices.selected")),
  );
  await vi.waitFor(() =>
    expect(button(harness.accounts, ".profile-auth-link-unlink").disabled).toBe(false),
  );
  expect(harness.accounts.querySelector('[data-auth-profile-id="openai:personal"]')).not.toBeNull();
  button(harness.accounts, ".profile-auth-link-unlink").click();
  await vi.waitFor(() =>
    expect(harness.accounts.textContent).toContain(t("profilePage.modelAccounts.notices.cleared")),
  );
  await vi.waitFor(() =>
    expect(harness.accounts.querySelectorAll(".profile-auth-account-select")).toHaveLength(2),
  );
  expect(harness.accounts.querySelector(".profile-auth-link-unlink")).toBeNull();
  expect(
    harness.request.mock.calls.some(([method]) => method.startsWith("users.authConnect.")),
  ).toBe(false);
});

it("loads retained accounts one page at a time without dropping earlier choices", async () => {
  const first = { ...connectedAccount, selected: false };
  const second = { ...first, authProfileId: "openai:work" };
  const harness = await mountAccounts(
    async () => {
      throw new Error("Unexpected account mutation");
    },
    {
      inventoryPages: [
        { profileId: "profile-1", accounts: [first], links: [], nextCursor: "page-2" },
        { profileId: "profile-1", accounts: [second], links: [] },
      ],
    },
  );
  expect(harness.accounts.textContent).not.toContain(first.authProfileId);
  button(harness.accounts, ".profile-auth-accounts-more").click();
  await vi.waitFor(() =>
    expect(harness.accounts.querySelectorAll(".profile-auth-account-select")).toHaveLength(2),
  );
  expect(harness.accounts.textContent).toContain(first.authProfileId);
  expect(harness.accounts.textContent).toContain(second.authProfileId);
  expect(harness.accounts.querySelector(".profile-auth-accounts-more")).toBeNull();
  expect(harness.request).toHaveBeenCalledWith("users.listModelAccounts", {
    profileId: "profile-1",
    cursor: "page-2",
  });
});

it("discards an inventory reply from the previous connection", async () => {
  const harness = await mountAccounts(async () => {
    throw new Error("Unexpected account mutation");
  });
  const old = createDeferred<UsersListModelAccountsResult>();
  harness.request.mockImplementationOnce(async () => old.promise);
  button(harness.accounts, ".profile-auth-accounts-refresh").click();
  harness.emit("reconnecting");
  harness.emit("connected");
  old.resolve({
    profileId: "profile-1",
    accounts: [connectedAccount],
    links: connectedResult.links,
  });
  await vi.advanceTimersByTimeAsync(0);
  await harness.accounts.updateComplete;
  expect(harness.accounts.textContent).not.toContain(connectedAccount.label);
  await vi.waitFor(() =>
    expect(button(harness.accounts, ".profile-auth-add-account").disabled).toBe(false),
  );
});

it("lets an admin link and unlink an existing model account", async () => {
  const harness = await mountAccounts(
    async (method) => {
      if (method === "users.linkAuthProfile") {
        return { links: connectedResult.links };
      }
      if (method === "users.unlinkAuthProfile") {
        return { links: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    },
    { scopes: ["operator.write", "operator.admin"] },
  );
  expect(harness.accounts.textContent).toContain(t("profilePage.modelAccounts.empty"));
  const linkInput = await input(harness.accounts, ".profile-auth-link-input", "openai:personal");
  button(harness.accounts, ".profile-auth-link-submit").click();
  await vi.waitFor(() => expect(harness.accounts.textContent).toContain(connectedAccount.label));
  expect(harness.request).toHaveBeenCalledWith("users.linkAuthProfile", {
    profileId: "profile-1",
    authProfileId: "openai:personal",
  });
  expect(linkInput.value).toBe("");
  button(harness.accounts, ".profile-auth-link-unlink").click();
  await vi.waitFor(() =>
    expect(harness.accounts.textContent).toContain(t("profilePage.modelAccounts.empty")),
  );
  expect(harness.request).toHaveBeenCalledWith("users.unlinkAuthProfile", {
    profileId: "profile-1",
    provider: "openai",
  });
});

it("polls one authorization at a time and uses its recorded outcome", async () => {
  const exchanging = createDeferred<UsersAuthConnectStatusResult>();
  let polls = 0;
  const harness = await mountAccounts(async (method, params) => {
    expect(method).toBe("users.authConnect.status");
    expect(params).toEqual({ profileId: "profile-1", connectId: "connect-1" });
    polls += 1;
    return polls === 1 ? exchanging.promise : connectedResult;
  });
  await harness.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(polls).toBe(1);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(polls).toBe(1);
  exchanging.resolve({
    status: "pending",
    step: { id: "saving", type: "progress", executor: "gateway", message: "Saving account…" },
  });
  await vi.waitFor(() => expect(harness.accounts.textContent).toContain("Saving account…"));
  expect(button(harness.accounts, ".profile-auth-connect-cancel").disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  await harness.accounts.updateComplete;
  expect(harness.accounts.textContent).toContain(connectedAccount.label);
  expect(harness.accounts.querySelector(".model-accounts-notice")?.textContent).toContain(
    "Account added.",
  );
  expect(harness.accounts.querySelector(".model-accounts-flow")).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(2);
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.listModelAccounts"),
  ).toHaveLength(2);
});

it.each([
  {
    result: { status: "cancelled" } as const,
    message: "profilePage.modelAccounts.notices.cancelled",
  },
  { result: { status: "expired" } as const, message: "profilePage.modelAccounts.notices.expired" },
  {
    result: { status: "failed", reason: "identity" } as const,
    message: "profilePage.modelAccounts.connectErrors.identity",
  },
])("shows a terminal $result.status result and stops polling", async ({ result, message }) => {
  const harness = await mountAccounts(async () => result);
  await harness.start();
  await vi.advanceTimersByTimeAsync(2_000);
  await harness.accounts.updateComplete;
  expect(harness.accounts.textContent).toContain(t(message));
  expect(harness.accounts.querySelector(".model-accounts-flow")).toBeNull();
  expect(button(harness.accounts, ".profile-auth-add-account").disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.authConnect.status"),
  ).toHaveLength(2);
});

it("waits for cancellation and ignores a late completion from the cancelled attempt", async () => {
  const completion = createDeferred<UsersAuthConnectStatusResult>();
  const cancellation = createDeferred<UsersAuthConnectStatusResult>();
  const harness = await mountAccounts(async (method) => {
    if (method === "users.authConnect.answer") {
      return completion.promise;
    }
    if (method === "users.authConnect.cancel") {
      return cancellation.promise;
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await harness.start();
  await input(
    harness.accounts,
    ".wizard-step__form input",
    "http://localhost:1455/auth/callback?code=code&state=1",
  );
  button(harness.accounts, '.wizard-step__form button[type="submit"]').click();
  await vi.waitFor(() =>
    expect(harness.request).toHaveBeenCalledWith("users.authConnect.answer", expect.anything()),
  );
  button(harness.accounts, ".profile-auth-connect-cancel").click();
  await harness.accounts.updateComplete;
  expect(harness.request).toHaveBeenCalledWith("users.authConnect.cancel", {
    profileId: "profile-1",
    connectId: "connect-1",
  });
  expect(harness.accounts.querySelector(".model-accounts-flow")).not.toBeNull();
  cancellation.resolve({ status: "cancelled" });
  await vi.waitFor(() => expect(harness.accounts.querySelector(".model-accounts-flow")).toBeNull());
  completion.resolve(connectedResult);
  await vi.advanceTimersByTimeAsync(0);
  await harness.accounts.updateComplete;
  expect(harness.accounts.textContent).toContain(t("profilePage.modelAccounts.notices.cancelled"));
  expect(harness.accounts.textContent).not.toContain(connectedAccount.label);
  expect(button(harness.accounts, ".profile-auth-add-account").disabled).toBe(false);
});

it("does not apply an old poll after reconnecting and starting a new attempt", async () => {
  const oldPoll = createDeferred<UsersAuthConnectStatusResult>();
  const harness = await mountAccounts(async () => oldPoll.promise);
  await harness.start();
  await vi.advanceTimersByTimeAsync(2_000);
  harness.emit("reconnecting");
  harness.emit("connected");
  await vi.waitFor(() =>
    expect(button(harness.accounts, ".profile-auth-add-account").disabled).toBe(false),
  );
  await harness.start();
  oldPoll.resolve(connectedResult);
  await vi.advanceTimersByTimeAsync(0);
  await harness.accounts.updateComplete;
  expect(
    harness.accounts.querySelector<HTMLAnchorElement>(".wizard-step__external-link")?.href,
  ).toContain("state=2");
  expect(harness.accounts.textContent).not.toContain(connectedAccount.label);
  expect(harness.accounts.querySelector(".model-accounts-flow")).not.toBeNull();
});

it("keeps a failed status check visible and lets the person retry it", async () => {
  let polls = 0;
  const harness = await mountAccounts(async () => {
    if (++polls === 1) {
      throw new Error("Gateway disconnected");
    }
    return connectedResult;
  });
  await harness.start();
  await vi.advanceTimersByTimeAsync(2_000);
  await harness.accounts.updateComplete;
  expect(harness.accounts.querySelector('[role="alert"]')?.textContent).toContain(
    "Gateway disconnected",
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(1);
  button(harness.accounts, ".profile-auth-connect-check").click();
  await vi.waitFor(() => expect(harness.accounts.textContent).toContain(connectedAccount.label));
  expect(harness.accounts.querySelector('[role="alert"]')).toBeNull();
});

it("stops at the operation deadline without pretending an unknown attempt expired", async () => {
  const harness = await mountAccounts(async () => ({ status: "pending" }), { expiresInMs: 2_500 });
  await harness.start();
  await vi.advanceTimersByTimeAsync(5_000);
  await harness.accounts.updateComplete;
  expect(harness.accounts.textContent).toContain(t("profilePage.modelAccounts.statusTimedOut"));
  expect(harness.accounts.querySelector(".model-accounts-flow")).not.toBeNull();
  expect(button(harness.accounts, ".profile-auth-connect-cancel").disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.authConnect.status"),
  ).toHaveLength(3);
});

it("shows personal sign-in context before writers enter a masked credential", async () => {
  const harness = await mountAccounts(
    async (method, params) => {
      expect(method).toBe("users.authConnect.answer");
      expect(params).toEqual({
        profileId: "profile-1",
        connectId: "connect-1",
        stepId: "api-key",
        value: "test-key",
      });
      return {
        status: "connected",
        authProfileId: "anthropic:personal",
        links: [{ provider: "anthropic", authProfileId: "anthropic:personal", updatedAt: 1 }],
      };
    },
    {
      gatewayUrl:
        "wss://synthetic-user:synthetic-password@test.invalid/control?token=synthetic-query#synthetic-fragment",
      step: { id: "api-key", type: "text", message: "Enter your API key", sensitive: true },
    },
  );
  expect(harness.accounts.querySelector(".profile-auth-link-input")).toBeNull();
  expect(harness.accounts.textContent).toContain("wss://test.invalid/control");
  expect(harness.accounts.innerHTML).not.toContain("synthetic-");
  expect(harness.accounts.textContent).toContain("Ada");
  expect(harness.accounts.textContent).toContain("Personal");
  expect(harness.accounts.querySelector('input[type="password"]')).toBeNull();
  await harness.start("anthropic");
  const token = await input(harness.accounts, ".wizard-step__form input", "test-key");
  expect(token.type).toBe("password");
  button(harness.accounts, '.wizard-step__form button[type="submit"]').click();
  await vi.waitFor(() => expect(harness.accounts.textContent).toContain(claudeAccount.label));
  expect(harness.accounts.querySelector(".model-accounts-notice")?.textContent).toContain(
    "Account added.",
  );
  expect(token.value).toBe("");
});

it("adds a catalog-provided account through its masked auth step without provider-specific controls", async () => {
  const step = {
    id: "grok-key",
    type: "text" as const,
    title: "Grok API key",
    message: "Enter your Grok API key",
    sensitive: true,
  };
  const account: UserModelAccount = {
    authProfileId: "xai:personal",
    provider: "xai",
    label: "Ada · Grok",
    authType: "api_key",
    selected: true,
  };
  const saving = createDeferred();
  const validationError = "That answer is not valid. Check the sign-in instructions and try again.";
  const harness = await mountAccounts(
    async (method, params) => {
      if (method === "users.authConnect.status") {
        return { status: "pending", step };
      }
      expect(method).toBe("users.authConnect.answer");
      if ((params as { stepId: string }).stepId === "notice") {
        expect(params).toEqual({
          profileId: "profile-1",
          connectId: "connect-1",
          stepId: "notice",
        });
        return { status: "pending", step };
      }
      if ((params as { value: string }).value === "invalid") {
        return { status: "pending", step, error: validationError };
      }
      expect(params).toEqual({
        profileId: "profile-1",
        connectId: "connect-1",
        stepId: step.id,
        value: "synthetic-grok-key",
      });
      await saving.promise;
      return {
        status: "connected",
        authProfileId: account.authProfileId,
        links: [{ provider: account.provider, authProfileId: account.authProfileId, updatedAt: 1 }],
      };
    },
    {
      step: { id: "notice", type: "note", message: "Use your own API key." },
      connectedAccounts: [account],
    },
  );
  expect(harness.accounts.querySelector('input[type="password"]')).toBeNull();
  await harness.start("xai");
  expect(harness.accounts.textContent).toContain("Use your own API key.");
  const noteButton = button(harness.accounts, ".wizard-step__actions button.primary");
  noteButton.click();
  await vi.waitFor(() =>
    expect(harness.accounts.querySelector('input[type="password"]')).not.toBeNull(),
  );
  noteButton.click();
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.authConnect.answer"),
  ).toHaveLength(1);
  expect(harness.request).toHaveBeenCalledWith("users.authConnect.start", {
    profileId: "profile-1",
    provider: "xai",
    method: "api-key",
  });
  const credential = await input(harness.accounts, 'input[type="password"]', "invalid");
  button(harness.accounts, '.wizard-step__form button[type="submit"]').click();
  await vi.waitFor(() =>
    expect(harness.accounts.querySelector('[role="alert"]')?.textContent).toContain(
      validationError,
    ),
  );
  await vi.waitFor(() => expect(credential.disabled).toBe(false));
  await input(harness.accounts, 'input[type="password"]', "synthetic-grok-key");
  await vi.advanceTimersByTimeAsync(2_000);
  await harness.accounts.updateComplete;
  expect(credential.value).toBe("synthetic-grok-key");
  expect(harness.accounts.querySelector('[role="alert"]')?.textContent).toContain(validationError);
  button(harness.accounts, '.wizard-step__form button[type="submit"]').click();
  await vi.waitFor(() => expect(credential.disabled).toBe(true));
  expect(credential.value).toBe("");
  saving.resolve();
  await vi.waitFor(() => expect(harness.accounts.querySelector(".model-accounts-flow")).toBeNull());
  expect(harness.accounts.querySelector('input[type="password"]')).toBeNull();
  expect(harness.accounts.querySelector('[role="alert"]')).toBeNull();
  expect(harness.accounts.textContent).toContain(account.label);
});
