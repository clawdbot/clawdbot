// Channels remove tests cover config mutation, plugin catalog repair hints, and account removal behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannelIngressQueue,
  purgeChannelIngressQueueAccount,
} from "../channels/message/ingress-queue.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks } from "./channels.mock-harness.js";
import {
  createExternalChatCatalogEntry,
  createExternalChatDeletePlugin,
} from "./channels.plugin-install.test-helpers.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

let channelsRemoveCommand: typeof import("./channels.js").channelsRemoveCommand;

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const registryRefreshMocks = vi.hoisted(() => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
}));

const ingressMocks = vi.hoisted(() => ({
  purgeFailure: null as Error | null,
  onPurge: null as (() => void) | null,
}));

// The command maps a channel to the plugin whose queue holds its rows by reading plugin
// manifests. Driving that list here pins all three shapes: a channel served by its own
// plugin, one served by a plugin under a different id, and one plugin serving several.
const manifestMocks = vi.hoisted(() => ({
  plugins: [{ id: "external-chat", channels: ["external-chat"] }] as Array<{
    id: string;
    channels: string[];
  }>,
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({ stopped: true })),
}));

// Disabling an account confirms at the terminal before it mutates anything.
const wizardMocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock("../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/catalog.js")>(
    "../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    listRawChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
  };
});

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
  };
});

vi.mock("../plugins/plugin-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/plugin-registry.js")>(
    "../plugins/plugin-registry.js",
  );
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: () => ({ plugins: manifestMocks.plugins }),
  };
});

vi.mock("./channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-setup/plugin-install.js")>(
    "./channel-setup/plugin-install.js",
  );
  const { createMockChannelSetupPluginInstallModule } =
    await import("./channels.plugin-install.test-helpers.js");
  return createMockChannelSetupPluginInstallModule(actual);
});

vi.mock("../channels/message/ingress-queue.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/message/ingress-queue.js")>(
    "../channels/message/ingress-queue.js",
  );
  return {
    ...actual,
    // Real purge unless a test arms a failure, so the state store stays authoritative.
    purgeChannelIngressQueueAccount: (
      params: Parameters<typeof actual.purgeChannelIngressQueueAccount>[0],
    ) => {
      ingressMocks.onPurge?.();
      if (ingressMocks.purgeFailure) {
        throw ingressMocks.purgeFailure;
      }
      return actual.purgeChannelIngressQueueAccount(params);
    },
  };
});

vi.mock("../plugins/registry-refresh.js", () => registryRefreshMocks);

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: wizardMocks.confirm }),
}));

const runtime = createTestRuntime();

function firstWrittenChannelsConfig() {
  return configMocks.writeConfigFile.mock.calls[0]?.[0] as
    | { channels?: Record<string, unknown> }
    | undefined;
}

describe("channelsRemoveCommand", () => {
  beforeAll(async () => {
    ({ channelsRemoveCommand } = await import("./channels.js"));
  });

  // Every case owns its state directory. Closing the handle is not isolation — it
  // releases the connection and clears the cache but deletes nothing, so a case that
  // seeded without draining stayed readable by the next one. The shared fixture is
  // what provides the directory, the env, and a removal that retries: these files are
  // held open on Windows, and a plain `fs.rm` loses that race.
  let state: OpenClawTestState;

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-channels-remove-",
      layout: "state-only",
    });
    resetPluginRuntimeStateForTest();
    manifestMocks.plugins = [{ id: "external-chat", channels: ["external-chat"] }];
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { nextConfig: unknown }) => {
        await configMocks.writeConfigFile(params.nextConfig);
      });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    registryRefreshMocks.refreshPluginRegistryAfterConfigMutation.mockClear();
    gatewayMocks.callGateway.mockClear();
    gatewayMocks.callGateway.mockResolvedValue({ stopped: true });
    wizardMocks.confirm.mockClear();
    wizardMocks.confirm.mockResolvedValue(true);
    ingressMocks.purgeFailure = null;
    ingressMocks.onPurge = null;
    setActivePluginRegistry(createTestRegistry());
  });

  it("asks users to add an external channel plugin before removing its account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel plugin "external-chat" is not installed. Run openclaw channels add --channel external-chat first.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("removes an external channel account when its plugin is already installed", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = createExternalChatDeletePlugin();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(registryRefreshMocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    const writtenConfig = firstWrittenChannelsConfig();
    expect(writtenConfig?.channels?.["external-chat"]).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps omitted removal on literal default when the plugin selects another default", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const deletePlugin = createExternalChatDeletePlugin();
    const defaultAccountId = vi.fn(() => "work");
    const scopedPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        defaultAccountId,
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(scopedPlugin.config.deleteAccount).toHaveBeenCalledWith({
      cfg: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
      accountId: "default",
    });
    expect(defaultAccountId).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded no stored ingress events.',
    );
  });

  it("stops an active gateway channel runtime before deleting a runtime-backed account", async () => {
    const callOrder: string[] = [];
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const deletePlugin = createExternalChatDeletePlugin();
    const scopedPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        deleteAccount: vi.fn((params) => {
          callOrder.push("delete");
          return deletePlugin.config.deleteAccount!(params);
        }),
      },
      gateway: {
        startAccount: vi.fn(),
      },
      lifecycle: {
        onAccountRemoved: vi.fn(() => {
          callOrder.push("lifecycle");
        }),
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    gatewayMocks.callGateway.mockImplementationOnce(async () => {
      callOrder.push("stop");
      return { stopped: true };
    });
    configMocks.writeConfigFile.mockImplementationOnce(async () => {
      callOrder.push("persist");
    });
    runtime.log.mockImplementationOnce(() => {
      callOrder.push("output");
    });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
      method: "channels.stop",
      params: {
        channel: "external-chat",
        accountId: "default",
      },
      mode: "backend",
      clientName: "gateway-client",
      deviceIdentity: null,
    });
    const writtenConfig = firstWrittenChannelsConfig();
    expect(writtenConfig?.channels?.["external-chat"]).toBeUndefined();
    expect(callOrder).toEqual(["stop", "delete", "lifecycle", "persist", "output"]);
  });

  it("stops a runtime-backed account before reporting an unsupported delete", async () => {
    const callOrder: string[] = [];
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const deletePlugin = createExternalChatDeletePlugin();
    const scopedPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        deleteAccount: undefined,
      },
      gateway: {
        startAccount: vi.fn(),
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    gatewayMocks.callGateway.mockImplementationOnce(async () => {
      callOrder.push("stop");
      return { stopped: true };
    });
    runtime.error.mockImplementationOnce(() => {
      callOrder.push("error");
    });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(callOrder).toEqual(["stop", "error"]);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("discards the ingress rows a deleted account owned and reports the unanswered ones", async () => {
    const callOrder: string[] = [];
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const scopedPlugin = createExternalChatDeletePlugin();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    // The runtime opens the queue under the plugin id, not the channel id it serves,
    // so an external plugin's rows are only found when removal resolves that owner.
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "never answered" });
    await queue.enqueue("inbound-2", { text: "already answered" });
    await queue.complete("inbound-2");
    configMocks.writeConfigFile.mockImplementationOnce(async () => {
      callOrder.push("persist");
    });
    ingressMocks.onPurge = () => {
      callOrder.push("discard");
    };
    runtime.log.mockImplementationOnce(() => {
      callOrder.push("output");
    });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 2 stored ingress events, including 1 never answered.',
    );
    // Discarding after the config write means a failed write cannot drop inbound work
    // for an account that is still configured.
    expect(callOrder).toEqual(["persist", "discard", "output"]);
    expect(
      purgeChannelIngressQueueAccount({
        channelId: "external-chat",
        accountId: "default",
      }),
    ).toEqual({ discarded: 0, undelivered: 0, recoverable: 0 });
  });

  it("keeps the ingress rows of a disabled account so re-enabling it drains them", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const deletePlugin = createExternalChatDeletePlugin();
    const scopedPlugin: ChannelPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        setAccountEnabled: ({ cfg }) => cfg,
      },
    };
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    // Seed under the id a discard would actually target, so this stays a real negative
    // control: seeding under the channel id would survive even if the disable path
    // started discarding.
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "waiting for the account to come back" });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
      },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith('Disabled external-chat account "default".');
    // The account can be re-enabled, so its queued work is still deliverable. Reading it
    // back through the purge both proves it survived and leaves the worker state clean.
    expect(
      purgeChannelIngressQueueAccount({
        channelId: "external-chat",
        accountId: "default",
      }),
    ).toEqual({ discarded: 1, undelivered: 1, recoverable: 0 });
  });

  it("keeps the ingress rows when the config write fails, so nothing is dropped for a still-configured account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "account is still configured" });
    configMocks.writeConfigFile.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      channelsRemoveCommand(
        { channel: "external-chat", account: "default", delete: true },
        runtime,
        { hasFlags: true },
      ),
    ).rejects.toThrow("disk full");

    // The account is still in config, so its queued work must still be there to drain.
    expect(
      purgeChannelIngressQueueAccount({
        channelId: "external-chat",
        accountId: "default",
      }),
    ).toEqual({ discarded: 1, undelivered: 1, recoverable: 0 });
  });

  it("still reports the deletion when the ingress discard fails", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    // The config write has already landed by then, so the account is gone either way.
    ingressMocks.purgeFailure = new Error("state database is owned by another process");

    await channelsRemoveCommand(
      { channel: "external-chat", account: "default", delete: true },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Its stored ingress events could not be discarded: state database is owned by another process',
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports a discard with no unanswered work without calling it lost", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "answered before removal" });
    await queue.complete("inbound-1");

    await channelsRemoveCommand(
      { channel: "external-chat", account: "default", delete: true },
      runtime,
      { hasFlags: true },
    );

    // Every row was settled, so the summary must not describe lost inbound work.
    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 1 stored ingress event.',
    );
  });

  it("counts a discarded dead letter as work, not as routine cleanup", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: { "external-chat": { enabled: true, token: "token-1" } },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "failed once" });
    const claim = await queue.claim("inbound-1", { ownerId: "worker" });
    if (!claim) {
      throw new Error("Expected a claimed ingress event");
    }
    await queue.fail(claim, { reason: "handler-error" });

    await channelsRemoveCommand(
      { channel: "external-chat", account: "default", delete: true },
      runtime,
      { hasFlags: true },
    );

    // `channels dead-letters resubmit` could have replayed this row until now, so the
    // deletion has to name it rather than fold it into the total.
    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 1 stored ingress event, including 1 awaiting resubmission.',
    );
  });

  it("discards the rows under the plugin id when that is not the channel id", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: { "external-chat": { enabled: true, token: "token-1" } },
      }),
    );
    // An installed plugin whose package id is not the channel it serves: the runtime
    // stored its rows under the package id, so addressing the channel id finds nothing.
    manifestMocks.plugins = [{ id: "@vendor/external-chat-plugin", channels: ["external-chat"] }];
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "@vendor/external-chat-plugin",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "never answered" });

    await channelsRemoveCommand(
      { channel: "external-chat", account: "default", delete: true },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 1 stored ingress event, including 1 never answered.',
    );
  });

  it("keeps the ingress rows when the channel is the multi-channel plugin's own id", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: { "external-chat": { enabled: true, token: "token-1" } },
      }),
    );
    // `channelPluginIdBelongsToManifest` accepts a channel whose id IS the plugin id even
    // when `channels` does not list it, so this shape is absent from the declared list and
    // must not be read as "no manifest claims this channel" - the queue is still shared.
    manifestMocks.plugins = [
      { id: "external-chat", channels: ["external-chat-text", "external-chat-voice"] },
    ];
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "external-chat",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "belongs to a sibling channel too" });

    await channelsRemoveCommand(
      { channel: "external-chat", account: "default", delete: true },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Kept its stored ingress events: plugin "external-chat" serves more than one channel and its stored events do not record which.',
    );
    await expect(queue.claimNext({ ownerId: "worker" })).resolves.toMatchObject({
      id: "inbound-1",
    });
  });

  it("keeps the ingress rows when one plugin serves several channels", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: { "external-chat": { enabled: true, token: "token-1" } },
      }),
    );
    // One plugin, two channels, one queue between them: the rows record no channel of
    // their own, so this account's removal cannot tell its rows from its sibling's.
    manifestMocks.plugins = [
      { id: "@vendor/external-chat-plugin", channels: ["external-chat", "external-chat-voice"] },
    ];
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: createExternalChatDeletePlugin(),
          source: "test",
        },
      ]),
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "@vendor/external-chat-plugin",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "belongs to a sibling channel too" });

    await channelsRemoveCommand(
      { channel: "external-chat", account: "default", delete: true },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Kept its stored ingress events: plugin "@vendor/external-chat-plugin" serves more than one channel and its stored events do not record which.',
    );
    // The sibling's unanswered event is still claimable, which is the whole point.
    await expect(queue.claimNext({ ownerId: "worker" })).resolves.toMatchObject({
      id: "inbound-1",
    });
  });
});
