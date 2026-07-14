// Discord tests cover components plugin behavior.
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

let clearDiscordComponentEntries: typeof import("./components-registry.js").clearDiscordComponentEntries;
let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let resolveDiscordComponentEntry: typeof import("./components-registry.js").resolveDiscordComponentEntry;
let resolveDiscordComponentEntryWithPersistence: typeof import("./components-registry.js").resolveDiscordComponentEntryWithPersistence;
let resolveDiscordModalEntry: typeof import("./components-registry.js").resolveDiscordModalEntry;
let resolveDiscordModalEntryWithPersistence: typeof import("./components-registry.js").resolveDiscordModalEntryWithPersistence;
let buildDiscordComponentCustomId: typeof import("./components.js").buildDiscordComponentCustomId;
let buildDiscordComponentMessage: typeof import("./components.js").buildDiscordComponentMessage;
let buildDiscordComponentMessageFlags: typeof import("./components.js").buildDiscordComponentMessageFlags;
let buildDiscordModalCustomId: typeof import("./components.js").buildDiscordModalCustomId;
let parseDiscordComponentCustomId: typeof import("./components.js").parseDiscordComponentCustomId;
let parseDiscordComponentCustomIdForInteraction: typeof import("./components.js").parseDiscordComponentCustomIdForInteraction;
let parseDiscordModalCustomId: typeof import("./components.js").parseDiscordModalCustomId;
let parseDiscordModalCustomIdForInteraction: typeof import("./components.js").parseDiscordModalCustomIdForInteraction;
let readDiscordComponentSpec: typeof import("./components.js").readDiscordComponentSpec;

beforeAll(async () => {
  ({
    clearDiscordComponentEntries,
    registerDiscordComponentEntries,
    resolveDiscordComponentEntry,
    resolveDiscordComponentEntryWithPersistence,
    resolveDiscordModalEntry,
    resolveDiscordModalEntryWithPersistence,
  } = await import("./components-registry.js"));
  ({
    buildDiscordComponentCustomId,
    buildDiscordComponentMessage,
    buildDiscordComponentMessageFlags,
    buildDiscordModalCustomId,
    parseDiscordComponentCustomId,
    parseDiscordComponentCustomIdForInteraction,
    parseDiscordModalCustomId,
    parseDiscordModalCustomIdForInteraction,
    readDiscordComponentSpec,
  } = await import("./components.js"));
});

describe("discord components", () => {
  it("round-trips custom id values that contain separators", () => {
    const componentId = "button=a;two space%3B";
    const modalId = "modal=x;y space%3D";

    const componentCustomId = buildDiscordComponentCustomId({ componentId, modalId });
    expect(componentCustomId).not.toContain(componentId);
    expect(componentCustomId).toContain("space");
    expect(parseDiscordComponentCustomId(componentCustomId)).toEqual({ componentId, modalId });
    expect(parseDiscordComponentCustomIdForInteraction(componentCustomId).data).toMatchObject({
      cid: componentId,
      mid: modalId,
    });

    const modalCustomId = buildDiscordModalCustomId(modalId);
    expect(modalCustomId).not.toContain(modalId);
    expect(modalCustomId).toContain("space");
    expect(parseDiscordModalCustomId(modalCustomId)).toBe(modalId);
    expect(parseDiscordModalCustomIdForInteraction(modalCustomId).data).toMatchObject({
      mid: modalId,
    });
  });

  it("keeps legacy percent-like custom id values raw", () => {
    expect(buildDiscordComponentCustomId({ componentId: "button_v1" })).toBe(
      "occomp:cid=button_v1",
    );
    expect(buildDiscordComponentCustomId({ componentId: "button=v1" })).toBe(
      "occomp:cid=button=v1",
    );
    expect(buildDiscordModalCustomId("modal_v1")).toBe("ocmodal:mid=modal_v1");
    expect(buildDiscordModalCustomId("modal=v1")).toBe("ocmodal:mid=modal=v1");
    expect(parseDiscordComponentCustomId("occomp:cid=button%3Bv1")).toEqual({
      componentId: "button%3Bv1",
    });
    expect(parseDiscordModalCustomId("ocmodal:mid=modal%3Dv1")).toBe("modal%3Dv1");
  });

  it("builds v2 containers with modal trigger", () => {
    const spec = readDiscordComponentSpec({
      text: "Choose a path",
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Approve", style: "success", callbackData: "codex:approve" }],
        },
      ],
      modal: {
        title: "Details",
        callbackData: "codex:modal",
        allowedUsers: ["discord:user-1"],
        fields: [{ type: "text", label: "Requester" }],
      },
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }

    const result = buildDiscordComponentMessage({ spec });
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.isV2).toBe(true);
    expect(buildDiscordComponentMessageFlags(result.components)).toBe(MessageFlags.IsComponentsV2);
    expect(result.modals).toHaveLength(1);

    const trigger = result.entries.find((entry) => entry.kind === "modal-trigger");
    expect(trigger?.modalId).toBe(result.modals[0]?.id);
    expect(result.entries.find((entry) => entry.kind === "button")?.callbackData).toBe(
      "codex:approve",
    );
    expect(result.modals[0]?.callbackData).toBe("codex:modal");
    expect(result.modals[0]?.allowedUsers).toEqual(["discord:user-1"]);
  });

  it.each([
    { label: "minimum", accentColor: 0, expected: 0 },
    { label: "maximum", accentColor: 0xffffff, expected: 0xffffff },
    { label: "negative", accentColor: -1, expected: undefined },
    { label: "fractional", accentColor: 1.5, expected: undefined },
    { label: "above maximum", accentColor: 0x1000000, expected: undefined },
  ])("serializes $label numeric container accent colors safely", ({ accentColor, expected }) => {
    const spec = readDiscordComponentSpec({
      text: "Status",
      container: { accentColor },
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }

    const serialized = buildDiscordComponentMessage({ spec }).components[0]?.serialize() as
      | { accent_color?: unknown }
      | undefined;

    if (expected === undefined) {
      expect(serialized).not.toHaveProperty("accent_color");
    } else {
      expect(serialized?.accent_color).toBe(expected);
    }
  });

  it("serializes disabled link buttons", () => {
    const spec = readDiscordComponentSpec({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Open docs",
              style: "link",
              url: "https://example.com/docs",
              disabled: true,
            },
          ],
        },
      ],
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }

    const result = buildDiscordComponentMessage({ spec });
    const serialized = result.components[0]?.serialize() as
      | { components?: Array<{ components?: Array<Record<string, unknown>> }> }
      | undefined;
    const button = serialized?.components?.[0]?.components?.[0];

    expect(button).toMatchObject({
      label: "Open docs",
      style: ButtonStyle.Link,
      url: "https://example.com/docs",
      disabled: true,
    });
    expect(result.entries).toHaveLength(0);
  });

  it("omits unset optional fields from persisted button entries", () => {
    const spec = readDiscordComponentSpec({
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Allow Once", style: "success" }],
        },
      ],
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }

    const result = buildDiscordComponentMessage({ spec });
    const entry = result.entries[0];
    if (!entry) {
      throw new Error("Expected button entry");
    }

    expect(Object.entries(entry).filter(([, value]) => value === undefined)).toEqual([]);
  });

  it("requires options for modal select fields", () => {
    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [{ type: "select", label: "Priority" }],
        },
      }),
    ).toThrow("options");
  });

  it("rejects malformed component count and length limits", () => {
    expect(() =>
      readDiscordComponentSpec({
        blocks: [
          {
            type: "actions",
            select: {
              type: "string",
              minValues: -1,
              options: [{ label: "One", value: "one" }],
            },
          },
        ],
      }),
    ).toThrow("components.blocks[0].select.minValues");

    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [{ type: "text", label: "Name", maxLength: 0 }],
        },
      }),
    ).toThrow("components.modal.fields[0].maxLength");

    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [
            {
              type: "select",
              label: "Priority",
              minValues: 0,
              options: [{ label: "High", value: "high" }],
            },
          ],
        },
      }),
    ).toThrow("components.modal.fields[0].minValues");

    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [
            {
              type: "checkbox",
              label: "Choices",
              maxValues: 25,
              options: [{ label: "One", value: "one" }],
            },
          ],
        },
      }),
    ).toThrow("components.modal.fields[0].maxValues");

    expect(() =>
      readDiscordComponentSpec({
        blocks: [
          {
            type: "actions",
            select: {
              type: "string",
              maxValues: 0,
              options: [{ label: "One", value: "one" }],
            },
          },
        ],
      }),
    ).toThrow("components.blocks[0].select.maxValues");

    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [
            {
              type: "radio",
              label: "Choice",
              minValues: 1,
              options: [{ label: "One", value: "one" }],
            },
          ],
        },
      }),
    ).toThrow("components.modal.fields[0].minValues/maxValues");
  });

  it("requires attachment references for file blocks", () => {
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "https://example.com/report.pdf" }],
      }),
    ).toThrow("attachment://");
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "attachment://" }],
      }),
    ).toThrow("filename");
  });
});

describe("discord component registry", () => {
  beforeEach(() => {
    clearDiscordComponentEntries();
    vi.restoreAllMocks();
  });

  const componentsRegistryModuleUrl = new URL("./components-registry.ts", import.meta.url).href;

  it("registers and consumes component entries", () => {
    registerDiscordComponentEntries({
      entries: [{ id: "btn_1", kind: "button", label: "Confirm" }],
      modals: [
        {
          id: "mdl_1",
          title: "Details",
          fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
        },
      ],
      messageId: "msg_1",
      ttlMs: 1000,
    });

    const entry = resolveDiscordComponentEntry({ id: "btn_1", consume: false });
    expect(entry?.messageId).toBe("msg_1");

    const modal = resolveDiscordModalEntry({ id: "mdl_1", consume: false });
    expect(modal?.messageId).toBe("msg_1");

    const consumed = resolveDiscordComponentEntry({ id: "btn_1" });
    expect(consumed?.id).toBe("btn_1");
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });

  it("consumes sibling entries from the same non-reusable component message", () => {
    const result = buildDiscordComponentMessage({
      spec: {
        text: "Confirm action",
        blocks: [
          {
            type: "actions",
            buttons: [
              { label: "Confirm", callbackData: "confirm" },
              { label: "Cancel", callbackData: "cancel" },
            ],
          },
        ],
      },
    });
    const confirm = result.entries.find((entry) => entry.label === "Confirm");
    const cancel = result.entries.find((entry) => entry.label === "Cancel");
    if (!confirm?.consumptionGroupId) {
      throw new Error("expected confirm entry to carry a consumption group id");
    }
    if (!cancel) {
      throw new Error("expected cancel entry");
    }
    expect(cancel.consumptionGroupId).toBe(confirm.consumptionGroupId);
    expect(confirm.consumptionGroupEntryIds).toEqual([confirm.id, cancel.id]);

    registerDiscordComponentEntries({
      entries: result.entries,
      modals: [],
      messageId: "msg_1",
      ttlMs: 1000,
    });

    const consumed = resolveDiscordComponentEntry({ id: confirm?.id ?? "" });
    expect(consumed?.label).toBe("Confirm");
    expect(resolveDiscordComponentEntry({ id: cancel?.id ?? "", consume: false })).toBeNull();
  });

  it("shares registry state across duplicate module instances", async () => {
    const first = (await import(
      `${componentsRegistryModuleUrl}?t=first-${Date.now()}`
    )) as typeof import("./components-registry.js");
    const second = (await import(
      `${componentsRegistryModuleUrl}?t=second-${Date.now()}`
    )) as typeof import("./components-registry.js");

    first.clearDiscordComponentEntries();
    first.registerDiscordComponentEntries({
      entries: [{ id: "btn_shared", kind: "button", label: "Shared" }],
      modals: [],
    });

    const sharedEntry = second.resolveDiscordComponentEntry({ id: "btn_shared", consume: false });
    expect(sharedEntry?.id).toBe("btn_shared");
    expect(sharedEntry?.kind).toBe("button");
    expect(sharedEntry?.label).toBe("Shared");
    expect(typeof sharedEntry?.createdAt).toBe("number");
    expect(typeof sharedEntry?.expiresAt).toBe("number");

    second.clearDiscordComponentEntries();
  });

  it("expires component entries registered while the process clock is invalid", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      registerDiscordComponentEntries({
        entries: [{ id: "btn_invalid_clock", kind: "button", label: "Invalid clock" }],
        modals: [],
        ttlMs: 1000,
      });

      expect(resolveDiscordComponentEntry({ id: "btn_invalid_clock", consume: false })).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("expires component entries whose calculated expiry exceeds the Date range", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    try {
      registerDiscordComponentEntries({
        entries: [{ id: "btn_overflow", kind: "button", label: "Overflow" }],
        modals: [],
        ttlMs: 1000,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(resolveDiscordComponentEntry({ id: "btn_overflow", consume: false })).toBeNull();
  });

  it("persists component and modal entries when runtime state is available", async () => {
    const componentRegister = vi.fn().mockResolvedValue(undefined);
    const modalRegister = vi.fn().mockResolvedValue(undefined);
    const componentLookup = vi.fn().mockResolvedValue({
      version: 1,
      entry: { id: "btn_persisted", kind: "button", label: "Persisted" },
    });
    const modalLookup = vi.fn().mockResolvedValue({
      version: 1,
      entry: { id: "mdl_persisted", title: "Persisted", fields: [] },
    });
    const componentStore = {
      register: componentRegister,
      lookup: componentLookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    };
    const modalStore = {
      register: modalRegister,
      lookup: modalLookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    };
    const openKeyedStore = vi.fn((opts: { namespace: string }) =>
      opts.namespace === "discord.components" ? componentStore : modalStore,
    );
    const { setDiscordRuntime } = await import("./runtime.js");
    setDiscordRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    const now = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      registerDiscordComponentEntries({
        entries: [{ id: "btn_1", kind: "button", label: "Confirm" }],
        modals: [{ id: "mdl_1", title: "Details", fields: [] }],
        ttlMs: 1000,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    await vi.waitFor(() => expect(componentRegister).toHaveBeenCalledTimes(1));
    expect(componentRegister).toHaveBeenCalledWith(
      "btn_1",
      {
        version: 1,
        entry: {
          id: "btn_1",
          kind: "button",
          label: "Confirm",
          createdAt: now,
          expiresAt: now + 1000,
        },
      },
      { ttlMs: 1000 },
    );
    expect(modalRegister).toHaveBeenCalledWith(
      "mdl_1",
      {
        version: 1,
        entry: {
          id: "mdl_1",
          title: "Details",
          fields: [],
          createdAt: now,
          expiresAt: now + 1000,
        },
      },
      { ttlMs: 1000 },
    );

    clearDiscordComponentEntries();
    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: "btn_persisted", consume: false }),
    ).resolves.toStrictEqual({ id: "btn_persisted", kind: "button", label: "Persisted" });
    await expect(
      resolveDiscordModalEntryWithPersistence({ id: "mdl_persisted", consume: false }),
    ).resolves.toStrictEqual({ id: "mdl_persisted", title: "Persisted", fields: [] });
    expect(componentLookup).toHaveBeenCalledWith("btn_persisted");
    expect(modalLookup).toHaveBeenCalledWith("mdl_persisted");
    expect(openKeyedStore).toHaveBeenCalledTimes(4);
  });

  it("omits undefined component fields before persisting registry state", async () => {
    const componentRegister = vi.fn().mockResolvedValue(undefined);
    const modalRegister = vi.fn().mockResolvedValue(undefined);
    const componentStore = {
      register: componentRegister,
      lookup: vi.fn(),
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    };
    const modalStore = {
      register: modalRegister,
      lookup: vi.fn(),
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    };
    const openKeyedStore = vi.fn((opts: { namespace: string }) =>
      opts.namespace === "discord.components" ? componentStore : modalStore,
    );
    const { setDiscordRuntime } = await import("./runtime.js");
    setDiscordRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    const componentEntry = Object.assign(
      {
        id: "btn_undefined",
        kind: "button",
        label: "Approve",
        callbackData: "approve",
      } satisfies DiscordComponentEntry,
      { modalId: undefined, sessionKey: undefined },
    );
    const modalEntry = Object.assign(
      {
        id: "mdl_undefined",
        title: "Details",
        fields: [
          Object.assign(
            {
              id: "fld_undefined",
              name: "reason",
              label: "Reason",
              type: "text",
            } satisfies DiscordModalEntry["fields"][number],
            { description: undefined, placeholder: undefined },
          ),
        ],
      } satisfies DiscordModalEntry,
      { sessionKey: undefined },
    );

    registerDiscordComponentEntries({
      entries: [componentEntry],
      modals: [modalEntry],
      ttlMs: 1000,
    });

    await vi.waitFor(() => expect(componentRegister).toHaveBeenCalledTimes(1));
    expect(modalRegister).toHaveBeenCalledTimes(1);

    const persistedComponent = componentRegister.mock.calls[0]?.[1] as
      | { entry: Record<string, unknown> }
      | undefined;
    expect(persistedComponent?.entry.callbackData).toBe("approve");
    expect(persistedComponent?.entry).not.toHaveProperty("modalId");
    expect(persistedComponent?.entry).not.toHaveProperty("sessionKey");
    expect(persistedComponent?.entry).not.toHaveProperty("messageId");

    const modalPayload = modalRegister.mock.calls[0]?.[1] as
      | { entry: { fields?: Array<Record<string, unknown>> } }
      | undefined;
    expect(modalPayload?.entry.fields?.[0]).not.toHaveProperty("description");
    expect(modalPayload?.entry.fields?.[0]).not.toHaveProperty("placeholder");
    expect(modalPayload?.entry).not.toHaveProperty("sessionKey");
    expect(modalPayload?.entry).not.toHaveProperty("messageId");

    const inMemoryComponent = resolveDiscordComponentEntry({ id: "btn_undefined", consume: false });
    expect(inMemoryComponent).toHaveProperty("modalId", undefined);
    expect(inMemoryComponent).toHaveProperty("sessionKey", undefined);
  });

  it("deletes sibling persistent component entries when a group entry is consumed", async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const componentStore = {
      register: vi.fn(),
      lookup: vi.fn(),
      consume: vi.fn().mockResolvedValue({
        version: 1,
        entry: {
          id: "btn_confirm",
          kind: "button",
          label: "Confirm",
          consumptionGroupId: "grp_1",
          consumptionGroupEntryIds: ["btn_confirm", "btn_cancel"],
        },
      }),
      delete: componentDelete,
    };
    const modalStore = {
      register: vi.fn(),
      lookup: vi.fn(),
      consume: vi.fn(),
      delete: vi.fn(),
    };
    const openKeyedStore = vi.fn((opts: { namespace: string }) =>
      opts.namespace === "discord.components" ? componentStore : modalStore,
    );
    const { setDiscordRuntime } = await import("./runtime.js");
    setDiscordRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    clearDiscordComponentEntries();
    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: "btn_confirm" }),
    ).resolves.toStrictEqual({
      id: "btn_confirm",
      kind: "button",
      label: "Confirm",
      consumptionGroupId: "grp_1",
      consumptionGroupEntryIds: ["btn_confirm", "btn_cancel"],
    });

    await vi.waitFor(() => expect(componentDelete).toHaveBeenCalledWith("btn_cancel"));
    expect(componentDelete).toHaveBeenCalledWith("btn_confirm");
  });

  it("falls back to the in-memory registry when persistent state cannot open", async () => {
    const warn = vi.fn();
    const cause = new TypeError("disk busy");
    const { setDiscordRuntime } = await import("./runtime.js");
    setDiscordRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          const error = new Error("sqlite unavailable") as Error & { cause?: unknown };
          error.cause = cause;
          throw error;
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    registerDiscordComponentEntries({
      entries: [{ id: "btn_fallback", kind: "button", label: "Fallback" }],
      modals: [],
    });

    const fallbackEntry = resolveDiscordComponentEntry({ id: "btn_fallback", consume: false });
    expect(fallbackEntry?.id).toBe("btn_fallback");
    expect(fallbackEntry?.kind).toBe("button");
    expect(fallbackEntry?.label).toBe("Fallback");
    expect(typeof fallbackEntry?.createdAt).toBe("number");
    expect(typeof fallbackEntry?.expiresAt).toBe("number");
    expect(warn).toHaveBeenCalledWith(
      "Discord persistent component registry state failed",
      expect.objectContaining({
        error: "Error: sqlite unavailable",
        errorName: "Error",
        errorMessage: "sqlite unavailable",
        errorCause: "TypeError: disk busy",
        errorCauseName: "TypeError",
        errorCauseMessage: "disk busy",
      }),
    );
  });
});
