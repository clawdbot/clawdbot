/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { i18n, t } from "../i18n/index.ts";
import { AgentSelect } from "./agent-select.ts";

const AGENT_SELECT_TEST_TAG = `test-openclaw-agent-select-${crypto.randomUUID()}`;

customElements.define(AGENT_SELECT_TEST_TAG, class extends AgentSelect {});

type AgentSelectElement = HTMLElement & {
  agents: GatewayAgentRow[];
  selectedId: string | null;
  defaultId: string | null;
  identityById: Record<string, AgentIdentityResult>;
  authToken: string | null;
  disabled: boolean;
  onSelect: (agentId: string) => void;
  updateComplete: Promise<boolean>;
};

const agents: GatewayAgentRow[] = [
  { id: "alpha", name: "Alpha agent" },
  { id: "beta", name: "Beta agent" },
];

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
  element.agents = agents;
  element.selectedId = "alpha";
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

it("renders an emoji text avatar when no image URL is available", async () => {
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { emoji: "🦉" }) },
  });

  try {
    expect(element.querySelector(".agent-select__avatar--text")?.textContent?.trim()).toBe("🦉");
    expect(element.querySelector("img.agent-select__avatar")).toBeNull();
  } finally {
    element.remove();
  }
});

it("falls back to the uppercase agent initial", async () => {
  const element = await createAgentSelect();

  try {
    expect(element.querySelector(".agent-select__avatar--text")?.textContent?.trim()).toBe("A");
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
    expect(element.querySelector(".agent-select__avatar--text")?.textContent?.trim()).toBe("A");
    expect(fetchMock).toHaveBeenCalledWith("/avatar/alpha", {
      headers: { Authorization: "Bearer tok" },
    });

    await vi.waitFor(() => {
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(element.querySelector("img.agent-select__avatar")).toBeNull();

    element.authToken = "tok2";
    await element.updateComplete;

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/avatar/alpha", {
        headers: { Authorization: "Bearer tok2" },
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
  const element = await createAgentSelect({ defaultId: "beta" });

  try {
    const dropdown = element.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    const options = Array.from(
      element.querySelectorAll<HTMLElement & { checked: boolean; value: string }>(
        "wa-dropdown-item",
      ),
    );
    expect(dropdown).not.toBeNull();
    expect(options).toHaveLength(2);
    expect(options[0]?.checked).toBe(true);
    expect(options[1]?.checked).toBe(false);
    expect(options[0]?.value).toBe("alpha");
    expect(options[1]?.value).toBe("beta");
    expect(options[1]?.querySelector(".agent-select__badge")?.textContent?.trim()).toBe("default");
    expect(dropdown?.shadowRoot?.querySelector('[role="menu"]')).not.toBeNull();
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
    const beta = element.querySelector('[data-agent-id="beta"]');
    const dropdown = element.querySelector("wa-dropdown");
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: beta }, bubbles: true }),
    );

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("beta");

    const alpha = element.querySelector('[data-agent-id="alpha"]');
    const repeatedSelection = new CustomEvent("wa-select", {
      detail: { item: alpha },
      bubbles: true,
      cancelable: true,
    });
    (alpha as HTMLElement).focus();
    dropdown?.dispatchEvent(repeatedSelection);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(repeatedSelection.defaultPrevented).toBe(true);
    expect((alpha as HTMLElement & { checked: boolean }).checked).toBe(true);
    expect(document.activeElement).toBe(element.querySelector(".agent-select__trigger"));
  } finally {
    element.remove();
  }
});

it("renders a disabled trigger with the empty-state label", async () => {
  const element = await createAgentSelect({ agents: [], selectedId: null });

  try {
    const trigger = element.querySelector<HTMLButtonElement>(".agent-select__trigger");
    expect(trigger?.disabled).toBe(true);
    expect(element.querySelector(".agent-select__label")?.textContent?.trim()).toBe("No agents");
  } finally {
    element.remove();
  }
});

it("refreshes translated labels when the locale changes while mounted", async () => {
  await i18n.setLocale("en");
  const element = await createAgentSelect({ agents: [], selectedId: null });

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
