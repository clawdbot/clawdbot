import { MessageFlags } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let clearDiscordComponentEntries: typeof import("./components-registry.js").clearDiscordComponentEntries;
let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let resolveDiscordComponentEntry: typeof import("./components-registry.js").resolveDiscordComponentEntry;
let resolveDiscordComponentEntryWithPersistence: typeof import("./components-registry.js").resolveDiscordComponentEntryWithPersistence;
let resolveDiscordModalEntry: typeof import("./components-registry.js").resolveDiscordModalEntry;
let resolveDiscordModalEntryWithPersistence: typeof import("./components-registry.js").resolveDiscordModalEntryWithPersistence;
let buildDiscordComponentMessage: typeof import("./components.js").buildDiscordComponentMessage;
let buildDiscordComponentMessageFlags: typeof import("./components.js").buildDiscordComponentMessageFlags;
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
  ({ buildDiscordComponentMessage, buildDiscordComponentMessageFlags, readDiscordComponentSpec } =
    await import("./components.js"));
});

describe("discord components", () => {
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

    expect(second.resolveDiscordComponentEntry({ id: "btn_shared", consume: false })).toMatchObject(
      {
        id: "btn_shared",
        label: "Shared",
      },
    );

    second.clearDiscordComponentEntries();
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

    registerDiscordComponentEntries({
      entries: [{ id: "btn_1", kind: "button", label: "Confirm" }],
      modals: [{ id: "mdl_1", title: "Details", fields: [] }],
      ttlMs: 1000,
    });

    await vi.waitFor(() => expect(componentRegister).toHaveBeenCalledTimes(1));
    expect(componentRegister).toHaveBeenCalledWith(
      "btn_1",
      { version: 1, entry: expect.objectContaining({ id: "btn_1" }) },
      { ttlMs: 1000 },
    );
    expect(modalRegister).toHaveBeenCalledWith(
      "mdl_1",
      { version: 1, entry: expect.objectContaining({ id: "mdl_1" }) },
      { ttlMs: 1000 },
    );

    clearDiscordComponentEntries();
    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: "btn_persisted", consume: false }),
    ).resolves.toMatchObject({ id: "btn_persisted" });
    await expect(
      resolveDiscordModalEntryWithPersistence({ id: "mdl_persisted", consume: false }),
    ).resolves.toMatchObject({ id: "mdl_persisted" });
    expect(componentLookup).toHaveBeenCalledWith("btn_persisted");
    expect(modalLookup).toHaveBeenCalledWith("mdl_persisted");
    expect(openKeyedStore).toHaveBeenCalledTimes(4);
  });

  it("falls back to the in-memory registry when persistent state cannot open", async () => {
    const warn = vi.fn();
    const { setDiscordRuntime } = await import("./runtime.js");
    setDiscordRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    registerDiscordComponentEntries({
      entries: [{ id: "btn_fallback", kind: "button", label: "Fallback" }],
      modals: [],
    });

    expect(resolveDiscordComponentEntry({ id: "btn_fallback", consume: false })).toMatchObject({
      id: "btn_fallback",
      label: "Fallback",
    });
    expect(warn).toHaveBeenCalled();
  });
});
