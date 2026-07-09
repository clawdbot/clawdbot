/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import "./agent-select.ts";

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
  const element = document.createElement("openclaw-agent-select") as AgentSelectElement;
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

it("opens a listbox with selection state and a default badge", async () => {
  const element = await createAgentSelect({ defaultId: "beta" });

  try {
    element.querySelector<HTMLButtonElement>(".agent-select__trigger")?.click();
    await element.updateComplete;

    const listbox = element.querySelector('[role="listbox"]');
    const options = Array.from(
      element.querySelectorAll<HTMLButtonElement>('.agent-select__option[role="option"]'),
    );
    expect(listbox).not.toBeNull();
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.getAttribute("aria-selected")).toBe("false");
    expect(options[1]?.querySelector(".agent-select__badge")?.textContent?.trim()).toBe("default");
    expect(document.activeElement).toBe(options[0]);
  } finally {
    element.remove();
  }
});

it("supports trigger and listbox keyboard navigation", async () => {
  const element = await createAgentSelect();

  try {
    const trigger = element.querySelector<HTMLButtonElement>(".agent-select__trigger");
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await element.updateComplete;

    const options = Array.from(
      element.querySelectorAll<HTMLButtonElement>(".agent-select__option"),
    );
    // Options are focused programmatically, never sequential tab stops.
    expect(options.every((option) => option.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(options[0]);

    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);

    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(options[0]);

    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);

    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector('[role="listbox"]')).toBeNull();
    // Tab hands focus back to the trigger so sequential navigation continues.
    expect(document.activeElement).toBe(trigger);
  } finally {
    element.remove();
  }
});

it("jumps focus to a matching agent via printable-key type-ahead", async () => {
  const element = await createAgentSelect();

  try {
    element.querySelector<HTMLButtonElement>(".agent-select__trigger")?.click();
    await element.updateComplete;
    const options = Array.from(
      element.querySelectorAll<HTMLButtonElement>(".agent-select__option"),
    );
    expect(document.activeElement).toBe(options[0]);

    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);

    // Accumulated prefix keeps matching the same agent instead of cycling.
    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
  } finally {
    element.remove();
  }
});

it("selects a different agent and ignores the already-selected agent", async () => {
  const onSelect = vi.fn<(agentId: string) => void>();
  const element = await createAgentSelect({ onSelect });

  try {
    const trigger = element.querySelector<HTMLButtonElement>(".agent-select__trigger");
    trigger?.click();
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('[data-agent-id="beta"]')?.click();
    await element.updateComplete;

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("beta");
    expect(element.querySelector('[role="listbox"]')).toBeNull();

    trigger?.click();
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('[data-agent-id="alpha"]')?.click();
    await element.updateComplete;

    expect(onSelect).toHaveBeenCalledOnce();
    expect(element.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    element.remove();
  }
});

it("closes on Escape or outside pointerdown and refocuses the trigger on Escape", async () => {
  const element = await createAgentSelect();

  try {
    const trigger = element.querySelector<HTMLButtonElement>(".agent-select__trigger");
    trigger?.click();
    await element.updateComplete;
    element
      .querySelector(".agent-select__list")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;

    expect(element.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger?.click();
    await element.updateComplete;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    await element.updateComplete;

    expect(element.querySelector('[role="listbox"]')).toBeNull();
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
