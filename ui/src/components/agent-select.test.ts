/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { i18n, t } from "../i18n/index.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { AgentSelect, type AgentSelectOption } from "./agent-select.ts";

const AGENT_SELECT_TEST_TAG = `test-openclaw-agent-select-${crypto.randomUUID()}`;

customElements.define(AGENT_SELECT_TEST_TAG, class extends AgentSelect {});

type AgentSelectElement = HTMLElement & {
  options: AgentSelectOption[];
  value: string;
  accessibleLabel: string;
  identityById: Record<string, AgentIdentityResult>;
  authToken: string | null;
  disabled: boolean;
  onSelect: (value: string) => void;
  onCreateAgent: (() => void) | null;
  updateComplete: Promise<boolean>;
};

const agents: GatewayAgentRow[] = [
  { id: "alpha", name: "Alpha agent" },
  { id: "beta", name: "Beta agent" },
];
const options: AgentSelectOption[] = agents.map((agent) => ({
  value: agent.id,
  label: agent.name ?? agent.id,
  agent,
}));

function createIdentity(
  agentId: string,
  overrides: Partial<AgentIdentityResult>,
): AgentIdentityResult {
  return {
    agentId,
    name: "",
    avatar: "",
    ...overrides,
  };
}

async function createAgentSelect(
  overrides: Partial<Omit<AgentSelectElement, keyof HTMLElement>> = {},
): Promise<AgentSelectElement> {
  const element = document.createElement(AGENT_SELECT_TEST_TAG) as AgentSelectElement;
  element.options = options;
  element.value = "alpha";
  element.onCreateAgent = vi.fn();
  Object.assign(element, overrides);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("renders the selected label and a data URL image avatar", async () => {
  const dataUrl = "data:image/png;base64,x";
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { avatar: dataUrl }) },
  });

  try {
    expect(element.querySelector(".agent-select__label")?.textContent?.trim()).toBe("Alpha agent");
    expect(element.querySelector<HTMLImageElement>("img.agent-select__avatar")?.src).toContain(
      dataUrl,
    );
  } finally {
    element.remove();
  }
});

it("prefers the roster-projected avatar URL over the raw local source", async () => {
  const dataUrl = "data:image/png;base64,cm9zdGVy";
  const element = await createAgentSelect({
    options: [
      {
        value: "alpha",
        label: "Alpha agent",
        agent: {
          id: "alpha",
          identity: { avatar: "avatar.png", avatarUrl: dataUrl },
        },
      },
    ],
  });

  try {
    expect(element.querySelector<HTMLImageElement>("img.agent-select__avatar")?.src).toContain(
      dataUrl,
    );
  } finally {
    element.remove();
  }
});

it("renders an emoji text avatar when no image URL is available", async () => {
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { emoji: "🦉" }) },
  });

  try {
    expect(element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "🦉",
    );
    expect(element.querySelector("img.agent-select__avatar")).toBeNull();
  } finally {
    element.remove();
  }
});

it("falls back to the uppercase agent initial", async () => {
  const element = await createAgentSelect();

  try {
    expect(element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "A",
    );
  } finally {
    element.remove();
  }
});

it("fetches local avatars with the bearer credential when token auth is active", async () => {
  const createObjectURL = vi.fn(() => "blob:agent-avatar");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["avatar"]),
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const element = await createAgentSelect({
    authToken: "tok",
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    // Text fallback renders while the authenticated fetch is in flight.
    expect(element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "A",
    );
    expect(fetchMock).toHaveBeenCalledWith("/avatar/alpha", {
      headers: { Authorization: "Bearer tok" },
      signal: expect.any(AbortSignal),
    });

    await waitForFast(() => {
      expect(
        element.querySelector<HTMLImageElement>("img.agent-select__avatar")?.getAttribute("src"),
      ).toBe("blob:agent-avatar");
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    element.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:agent-avatar");
  } finally {
    element.remove();
    vi.unstubAllGlobals();
  }
});

it("refetches a failed local avatar after the auth credential rotates", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:rotated-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true, blob: async () => new Blob(["avatar"]) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const element = await createAgentSelect({
    authToken: "tok",
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(element.querySelector("img.agent-select__avatar")).toBeNull();

    element.authToken = "tok2";
    await element.updateComplete;

    await waitForFast(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/avatar/alpha", {
        headers: { Authorization: "Bearer tok2" },
        signal: expect.any(AbortSignal),
      });
      expect(
        element.querySelector<HTMLImageElement>("img.agent-select__avatar")?.getAttribute("src"),
      ).toBe("blob:rotated-avatar");
    });
  } finally {
    element.remove();
    vi.unstubAllGlobals();
  }
});

it("aborts the stale request on auth rotation without duplicating the current fetch", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:rotated-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  const pending: Array<{
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }> = [];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("missing agent avatar fetch signal");
    }
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, signal });
      signal.addEventListener("abort", () => reject(new Error("avatar fetch aborted")), {
        once: true,
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const element = await createAgentSelect({
    authToken: "tok",
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    element.authToken = "tok2";
    await element.updateComplete;
    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(pending[0]?.signal.aborted).toBe(true);
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer tok", "Bearer tok2"]);

    // Let the canceled request's rejection settle, then force another render while
    // the replacement is pending. It must not clear the replacement's route claim.
    await Promise.resolve();
    element.identityById = { ...element.identityById };
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    pending[1]?.resolve({
      ok: true,
      blob: async () => new Blob(["avatar"]),
    } as Response);
    await waitForFast(() => {
      expect(
        element.querySelector<HTMLImageElement>("img.agent-select__avatar")?.getAttribute("src"),
      ).toBe("blob:rotated-avatar");
    });
  } finally {
    element.remove();
    vi.unstubAllGlobals();
  }
});

it("aborts a stalled local avatar fetch after the request deadline", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("missing agent avatar fetch signal");
    }
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const element = await createAgentSelect({
    authToken: "tok",
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = fetchMock.mock.calls[0] ?? [];
    expect(fetchInit?.signal?.aborted).toBe(false);
    expect(element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "A",
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchInit?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchInit?.signal?.aborted).toBe(true);

    await waitForFast(() => {
      expect(element.querySelector("img.agent-select__avatar")).toBeNull();
      expect(
        element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar"),
      ).toBe("A");
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    element.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("aborts a stalled local avatar body after the request deadline", async () => {
  vi.useFakeTimers();
  const blob = vi.fn<() => Promise<Blob>>();
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("missing agent avatar fetch signal");
    }
    blob.mockImplementation(
      () =>
        new Promise<Blob>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("avatar body read aborted")), {
            once: true,
          });
        }),
    );
    return { ok: true, blob } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const element = await createAgentSelect({
    authToken: "tok",
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitForFast(() => expect(blob).toHaveBeenCalledTimes(1));
    const [, fetchInit] = fetchMock.mock.calls[0] ?? [];

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchInit?.signal?.aborted).toBe(true);
    await waitForFast(() => {
      expect(element.querySelector("img.agent-select__avatar")).toBeNull();
      expect(
        element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar"),
      ).toBe("A");
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    element.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("renders a local avatar image when token auth is not active", async () => {
  const element = await createAgentSelect({
    authToken: null,
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    expect(element.querySelector<HTMLImageElement>("img.agent-select__avatar")?.src).toContain(
      "/avatar/alpha",
    );
  } finally {
    element.remove();
  }
});

it("renders the agent picker as a Web Awesome dropdown", async () => {
  const element = await createAgentSelect({
    options: options.map((option) =>
      option.value === "beta" ? { ...option, badge: "default" } : option,
    ),
  });

  try {
    const dropdown = element.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    const items = Array.from(
      element.querySelectorAll<HTMLElement & { checked: boolean; value: string }>(
        "wa-dropdown-item[data-agent-option]",
      ),
    );
    expect(dropdown).not.toBeNull();
    expect(items).toHaveLength(2);
    expect(items[0]?.checked).toBe(true);
    expect(items[1]?.checked).toBe(false);
    expect(items[0]?.value).toBe("alpha");
    expect(items[1]?.value).toBe("beta");
    expect(items[1]?.querySelector(".agent-select__badge")?.textContent?.trim()).toBe("default");
    expect(dropdown?.shadowRoot?.querySelector('[role="menu"]')).not.toBeNull();
  } finally {
    element.remove();
  }
});

it("keeps avatar text out of typeahead and announces option metadata", async () => {
  const element = await createAgentSelect({
    accessibleLabel: "Agent",
    options: options.map((option) =>
      option.value === "beta"
        ? { ...option, description: "Handles research", badge: "Default" }
        : option,
    ),
    value: "beta",
  });

  try {
    const items = Array.from(
      element.querySelectorAll<HTMLElement & { value: string }>("[data-agent-option]"),
    );
    expect(items.find((item) => item.value === "alpha")?.textContent?.trim()).toBe("Alpha agent");
    expect(items.find((item) => item.value === "beta")?.getAttribute("aria-label")).toBe(
      "Beta agent, Handles research, Default",
    );
    expect(element.querySelector(".agent-select__trigger")?.getAttribute("aria-label")).toBe(
      "Agent: Beta agent, Default",
    );
  } finally {
    element.remove();
  }
});

it("shows an unmatched selected value instead of the first option", async () => {
  const element = await createAgentSelect({ value: "system-monitor" });

  try {
    expect(element.querySelector(".agent-select__label")?.textContent?.trim()).toBe(
      "system-monitor",
    );
    expect(element.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "S",
    );
    expect(
      Array.from(
        element.querySelectorAll<HTMLElement & { checked: boolean }>("[data-agent-option]"),
      ).some((item) => item.checked),
    ).toBe(false);
  } finally {
    element.remove();
  }
});

it("focuses and scrolls the selected row into view when opened", async () => {
  const element = await createAgentSelect({ value: "beta" });

  try {
    const beta = Array.from(
      element.querySelectorAll<HTMLElement & { active: boolean; value: string }>(
        "[data-agent-option]",
      ),
    ).find((item) => item.value === "beta");
    if (!beta) {
      throw new Error("expected beta option");
    }
    const scrollIntoView = vi.fn();
    Object.defineProperty(beta, "scrollIntoView", { configurable: true, value: scrollIntoView });
    element.querySelector("wa-dropdown")?.dispatchEvent(new CustomEvent("wa-after-show"));

    expect(beta.active).toBe(true);
    expect(document.activeElement).toBe(beta);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  } finally {
    element.remove();
  }
});

it("closes and rejects selection when disabled while open", async () => {
  const onSelect = vi.fn<(value: string) => void>();
  const element = await createAgentSelect({ onSelect });

  try {
    const dropdown = element.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    const beta = Array.from(
      element.querySelectorAll<HTMLElement & { disabled: boolean; value: string }>(
        "[data-agent-option]",
      ),
    ).find((item) => item.value === "beta");
    if (!dropdown || !beta) {
      throw new Error("expected dropdown and beta option");
    }
    dropdown.open = true;
    element.disabled = true;
    await element.updateComplete;

    expect(dropdown.open).toBe(false);
    expect(beta.disabled).toBe(true);
    const selection = new CustomEvent("wa-select", {
      bubbles: true,
      cancelable: true,
      detail: { item: beta },
    });
    dropdown.dispatchEvent(selection);
    expect(selection.defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  } finally {
    element.remove();
  }
});

it("uses Web Awesome to open and dismiss the dropdown", async () => {
  const element = await createAgentSelect();

  try {
    const trigger = element.querySelector<HTMLButtonElement>(".agent-select__trigger");
    const dropdown = element.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<boolean> }
    >("wa-dropdown");
    trigger?.click();
    await dropdown?.updateComplete;
    expect(dropdown?.open).toBe(true);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    await dropdown?.updateComplete;
    expect(dropdown?.open).toBe(false);
  } finally {
    element.remove();
  }
});

it("selects a different agent and ignores the already-selected agent", async () => {
  const onSelect = vi.fn<(agentId: string) => void>();
  const element = await createAgentSelect({ onSelect });

  try {
    const items = Array.from(
      element.querySelectorAll<HTMLElement & { checked: boolean; value: string }>(
        "[data-agent-option]",
      ),
    );
    const beta = items.find((item) => item.value === "beta");
    const alpha = items.find((item) => item.value === "alpha");
    if (!beta || !alpha) {
      throw new Error("expected alpha and beta options");
    }
    const dropdown = element.querySelector("wa-dropdown");
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: beta }, bubbles: true }),
    );

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("beta");

    const repeatedSelection = new CustomEvent("wa-select", {
      detail: { item: alpha },
      bubbles: true,
      cancelable: true,
    });
    (alpha as HTMLElement).focus();
    dropdown?.dispatchEvent(repeatedSelection);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(repeatedSelection.defaultPrevented).toBe(true);
    expect(alpha.checked).toBe(true);
    expect(document.activeElement).toBe(element.querySelector(".agent-select__trigger"));
  } finally {
    element.remove();
  }
});

it("selects an empty-string special option and exposes radio semantics", async () => {
  const onSelect = vi.fn<(value: string) => void>();
  const element = await createAgentSelect({
    options: [{ value: "", label: "All agents" }, ...options],
    value: "alpha",
    onSelect,
  });

  try {
    const items = Array.from(
      element.querySelectorAll<HTMLElement & { checked: boolean; value: string }>(
        "[data-agent-option]",
      ),
    );
    const allAgents = items.find((item) => item.value === "");
    if (!allAgents) {
      throw new Error("expected all-agents option");
    }
    await waitForFast(() => {
      expect(items.find((item) => item.value === "alpha")?.getAttribute("role")).toBe(
        "menuitemradio",
      );
      expect(items.find((item) => item.value === "alpha")?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(items.find((item) => item.value === "alpha")?.getAttribute("aria-label")).toBe(
        "Alpha agent",
      );
    });

    element
      .querySelector("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: allAgents }, bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith("");
  } finally {
    element.remove();
  }
});

it("opens the new-agent flow from the footer item", async () => {
  const onCreateAgent = vi.fn();
  const element = await createAgentSelect({ onCreateAgent });

  try {
    const item = element.querySelector("[data-create-agent]");
    element
      .querySelector("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));

    expect(onCreateAgent).toHaveBeenCalledOnce();
  } finally {
    element.remove();
  }
});

it("keeps the new-agent footer reachable with an empty roster", async () => {
  const element = await createAgentSelect({ options: [], value: "" });

  try {
    const trigger = element.querySelector<HTMLButtonElement>(".agent-select__trigger");
    expect(trigger?.disabled).toBe(false);
    expect(element.querySelector(".agent-select__label")?.textContent?.trim()).toBe("No agents");
  } finally {
    element.remove();
  }
});

it("disables an empty picker when no footer action is available", async () => {
  const element = await createAgentSelect({ options: [], value: "", onCreateAgent: null });

  try {
    expect(element.querySelector<HTMLButtonElement>(".agent-select__trigger")?.disabled).toBe(true);
    expect(element.querySelector("[data-create-agent]")).toBeNull();
  } finally {
    element.remove();
  }
});

it("refreshes translated labels when the locale changes while mounted", async () => {
  await i18n.setLocale("en");
  const element = await createAgentSelect({ options: [], value: "" });

  try {
    const label = element.querySelector(".agent-select__label");
    const englishLabel = label?.textContent?.trim();

    await i18n.setLocale("zh-CN");
    await element.updateComplete;

    const translatedLabel = element.querySelector(".agent-select__label");
    expect(translatedLabel?.textContent?.trim()).toBe(t("agents.noAgents"));
    expect(translatedLabel?.textContent?.trim()).not.toBe(englishLabel);
  } finally {
    element.remove();
    await i18n.setLocale("en");
  }
});
