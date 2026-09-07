// Discord tests cover components plugin behavior.
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDiscordComponentEntriesForTest } from "./components-registry.test-support.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let resolveDiscordComponentEntryWithPersistence: typeof import("./components-registry.js").resolveDiscordComponentEntryWithPersistence;
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
let coerceDiscordComponentParam: typeof import("./components.js").coerceDiscordComponentParam;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;
type DiscordRuntime = Parameters<typeof import("./runtime.js").setDiscordRuntime>[0];

const { clearRuntime: clearDiscordRuntime } = createPluginRuntimeStore<DiscordRuntime>({
  pluginId: "discord",
  errorMessage: "Discord runtime not initialized",
});

beforeAll(async () => {
  ({
    registerDiscordComponentEntries,
    resolveDiscordComponentEntryWithPersistence,
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
    coerceDiscordComponentParam,
  } = await import("./components.js"));
  ({ setDiscordRuntime } = await import("./runtime.js"));
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

  it.each([
    {
      label: "top-level text",
      raw: { text: "    body  " },
      expected: [{ type: 10, content: "    body  " }],
    },
    {
      label: "text block",
      raw: { blocks: [{ type: "text", text: "    body  " }] },
      expected: [{ type: 10, content: "    body  " }],
    },
    {
      label: "section text",
      raw: {
        blocks: [
          {
            type: "section",
            text: "    body  ",
            accessory: {
              type: "button",
              button: { label: " Read ", style: "link", url: "https://example.com" },
            },
          },
        ],
      },
      expected: [
        {
          type: 9,
          components: [{ type: 10, content: "    body  " }],
          accessory: { label: "Read" },
        },
      ],
    },
    {
      label: "section texts",
      raw: {
        blocks: [
          {
            type: "section",
            texts: ["    first  ", "    second  "],
            accessory: {
              type: "button",
              button: { label: " Read ", style: "link", url: "https://example.com" },
            },
          },
        ],
      },
      expected: [
        {
          type: 9,
          components: [
            { type: 10, content: "    first  " },
            { type: 10, content: "    second  " },
          ],
          accessory: { label: "Read" },
        },
      ],
    },
  ])("preserves $label whitespace through parsing and serialization", ({ raw, expected }) => {
    const spec = readDiscordComponentSpec(raw);
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }
    expect(buildDiscordComponentMessage({ spec }).components[0]?.serialize()).toMatchObject({
      type: 17,
      components: expected,
    });
  });

  it.each([
    {
      raw: { blocks: [{ type: "text", text: " \n\t " }] },
      error: "components.blocks[0].text cannot be empty",
    },
    {
      raw: { blocks: [{ type: "text", text: 1 }] },
      error: "components.blocks[0].text must be a string",
    },
    {
      raw: { blocks: [{ type: "section", texts: [" \n\t "] }] },
      error: "components.blocks[0].texts[0] cannot be empty",
    },
  ])("retains required component body validation: $error", ({ raw, error }) => {
    expect(() => readDiscordComponentSpec(raw)).toThrow(error);
  });

  it("keeps optional blank component text absent", () => {
    const spec = readDiscordComponentSpec({
      text: " \n\t ",
      blocks: [{ type: "text", text: "fallback" }],
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }
    expect(buildDiscordComponentMessage({ spec }).components[0]?.serialize()).toMatchObject({
      type: 17,
      components: [{ type: 10, content: "fallback" }],
    });
  });

  it("parses stringified component specs from MCP object transports", () => {
    const raw = JSON.stringify({ blocks: [{ type: "text", text: "Choose" }] });

    expect(readDiscordComponentSpec(coerceDiscordComponentParam(raw))).toMatchObject({
      blocks: [{ type: "text", text: "Choose" }],
    });
    expect(coerceDiscordComponentParam("not json")).toBe("not json");
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
    // The runtime slot is global across Vitest files; discard sibling mocks
    // before this suite opens its persistent registry stores.
    clearDiscordRuntime();
    clearDiscordComponentEntriesForTest();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearDiscordRuntime();
  });

  const componentsRegistryModuleUrl = new URL("./components-registry.ts", import.meta.url).href;
  const componentsRegistryStateModuleUrl = new URL(
    "./components-registry-state.ts",
    import.meta.url,
  ).href;

  it("registers and consumes component entries", async () => {
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

    const entry = await resolveDiscordComponentEntryWithPersistence({
      id: "btn_1",
      consume: false,
    });
    expect(entry?.messageId).toBe("msg_1");

    const modal = await resolveDiscordModalEntryWithPersistence({ id: "mdl_1", consume: false });
    expect(modal?.messageId).toBe("msg_1");

    const consumed = await resolveDiscordComponentEntryWithPersistence({ id: "btn_1" });
    expect(consumed?.id).toBe("btn_1");
    await expect(resolveDiscordComponentEntryWithPersistence({ id: "btn_1" })).resolves.toBeNull();
  });

  it.each([
    { placement: "row", buttonReusable: true, cardReusable: undefined, expectedReusable: true },
    { placement: "row", buttonReusable: true, cardReusable: false, expectedReusable: true },
    { placement: "row", buttonReusable: false, cardReusable: true, expectedReusable: false },
    { placement: "row", buttonReusable: undefined, cardReusable: true, expectedReusable: true },
    {
      placement: "row",
      buttonReusable: undefined,
      cardReusable: undefined,
      expectedReusable: undefined,
    },
    { placement: "section", buttonReusable: true, cardReusable: undefined, expectedReusable: true },
    { placement: "section", buttonReusable: false, cardReusable: true, expectedReusable: false },
    {
      placement: "section",
      buttonReusable: undefined,
      cardReusable: true,
      expectedReusable: true,
    },
  ] as const)(
    "preserves $placement button reuse=$buttonReusable over card reuse=$cardReusable through delivery",
    async ({ placement, buttonReusable, cardReusable, expectedReusable }) => {
      const { RequestClient } = await import("./internal/discord.js");
      const { sendDiscordComponentMessage } = await import("./send.components.js");
      const button = {
        label: "Refresh",
        callbackData: "refresh",
        ...(buttonReusable === undefined ? {} : { reusable: buttonReusable }),
      };
      const spec = readDiscordComponentSpec({
        ...(cardReusable === undefined ? {} : { reusable: cardReusable }),
        blocks: [
          placement === "row"
            ? { type: "actions", buttons: [button] }
            : { type: "section", text: "Actions", accessory: { type: "button", button } },
        ],
      });
      if (!spec) {
        throw new Error("Expected component spec to be parsed");
      }

      const requests: Array<{ method: string | undefined; path: string; body: unknown }> = [];
      const rest = new RequestClient("fixture-token", {
        queueRequests: false,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          requests.push({
            method: init?.method,
            path: url.pathname,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          });
          const message =
            init?.method === "GET"
              ? { id: "789", type: 0 }
              : { id: "delivered-message", channel_id: "789" };
          return new Response(JSON.stringify(message), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      const delivery = await sendDiscordComponentMessage("channel:789", spec, {
        cfg: { channels: { discord: { token: "fixture-token" } } },
        rest,
        token: "fixture-token",
      });
      expect(delivery.messageId).toBe("delivered-message");
      const sent = requests.find((request) => request.method === "POST");
      expect(sent?.path).toBe("/api/v10/channels/789/messages");
      expect(JSON.stringify(sent?.body)).not.toContain("reusable");

      const sentBody = sent?.body as {
        components?: Array<{
          components?: Array<{
            components?: Array<{ custom_id?: string }>;
            accessory?: { custom_id?: string };
          }>;
        }>;
      };
      const block = sentBody.components?.[0]?.components?.[0];
      const customId = block?.components?.[0]?.custom_id ?? block?.accessory?.custom_id;
      if (!customId) {
        throw new Error("Expected a delivered Discord button custom id");
      }
      const componentId = parseDiscordComponentCustomId(customId)?.componentId;
      if (!componentId) {
        throw new Error("Expected a registered Discord component id");
      }

      const registered = await resolveDiscordComponentEntryWithPersistence({
        id: componentId,
        consume: false,
      });
      expect(registered?.reusable).toBe(expectedReusable);
      const firstInteraction = await resolveDiscordComponentEntryWithPersistence({
        id: componentId,
        consume: !registered?.reusable,
      });
      expect(firstInteraction?.id).toBe(componentId);
      const secondInteraction = await resolveDiscordComponentEntryWithPersistence({
        id: componentId,
        consume: false,
      });
      expect(Boolean(secondInteraction)).toBe(expectedReusable === true);
    },
  );

  it("consumes sibling entries from the same non-reusable component message", async () => {
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

    const consumed = await resolveDiscordComponentEntryWithPersistence({ id: confirm?.id ?? "" });
    expect(consumed?.label).toBe("Confirm");
    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: cancel?.id ?? "", consume: false }),
    ).resolves.toBeNull();
  });

  it("shares registry state across duplicate module instances", async () => {
    const first = (await import(
      `${componentsRegistryModuleUrl}?t=first-${Date.now()}`
    )) as typeof import("./components-registry.js");
    const second = (await import(
      `${componentsRegistryModuleUrl}?t=second-${Date.now()}`
    )) as typeof import("./components-registry.js");

    clearDiscordComponentEntriesForTest();
    first.registerDiscordComponentEntries({
      entries: [{ id: "btn_shared", kind: "button", label: "Shared" }],
      modals: [],
    });

    const sharedEntry = await second.resolveDiscordComponentEntryWithPersistence({
      id: "btn_shared",
      consume: false,
    });
    expect(sharedEntry?.id).toBe("btn_shared");
    expect(sharedEntry?.kind).toBe("button");
    expect(sharedEntry?.label).toBe("Shared");
    expect(typeof sharedEntry?.createdAt).toBe("number");
    expect(typeof sharedEntry?.expiresAt).toBe("number");

    clearDiscordComponentEntriesForTest();
  });

  it("shares persistent registry state across duplicate state modules", async () => {
    const first = (await import(
      `${componentsRegistryStateModuleUrl}?t=first-${Date.now()}`
    )) as typeof import("./components-registry-state.js");
    const second = (await import(
      `${componentsRegistryStateModuleUrl}?t=second-${Date.now()}`
    )) as typeof import("./components-registry-state.js");

    first.discordComponentRegistryState.persistentRegistryDisabled = true;

    expect(second.discordComponentRegistryState).toBe(first.discordComponentRegistryState);
    expect(second.discordComponentRegistryState.persistentRegistryDisabled).toBe(true);
    clearDiscordComponentEntriesForTest();
  });

  it("expires component entries registered while the process clock is invalid", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      registerDiscordComponentEntries({
        entries: [{ id: "btn_invalid_clock", kind: "button", label: "Invalid clock" }],
        modals: [],
        ttlMs: 1000,
      });

      await expect(
        resolveDiscordComponentEntryWithPersistence({
          id: "btn_invalid_clock",
          consume: false,
        }),
      ).resolves.toBeNull();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("expires component entries whose calculated expiry exceeds the Date range", async () => {
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

    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: "btn_overflow", consume: false }),
    ).resolves.toBeNull();
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

    clearDiscordComponentEntriesForTest();
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

    const inMemoryComponent = await resolveDiscordComponentEntryWithPersistence({
      id: "btn_undefined",
      consume: false,
    });
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
    setDiscordRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    clearDiscordComponentEntriesForTest();
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

    const fallbackEntry = await resolveDiscordComponentEntryWithPersistence({
      id: "btn_fallback",
      consume: false,
    });
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
