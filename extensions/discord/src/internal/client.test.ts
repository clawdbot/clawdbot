// Discord tests cover client plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationCommandType, ComponentType, Routes } from "discord-api-types/v10";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, ComponentRegistry, type AnyListener } from "./client.js";
import { BaseCommand } from "./commands.js";
import { Button, StringSelectMenu, parseCustomId } from "./components.js";
import { DiscordError } from "./rest.js";
import { attachRestMock, createInternalTestClient } from "./test-builders.test-support.js";

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createTestCommand(params: {
  name: string;
  guildIds?: string[];
  options?: unknown[];
}): BaseCommand {
  return new (class extends BaseCommand {
    name = params.name;
    override description = `${params.name} command`;
    type = ApplicationCommandType.ChatInput;
    override guildIds = params.guildIds;
    serializeOptions() {
      return params.options;
    }
  })();
}

describe("ComponentRegistry", () => {
  it("preserves digit-only custom id values as strings", () => {
    const parsed = parseCustomId("agent:user=123456789012345678;count=42;enabled=true");

    expect(parsed.data.user).toBe("123456789012345678");
    expect(parsed.data.count).toBe("42");
    expect(parsed.data.enabled).toBe(true);
  });

  it("resolves wildcard parser entries by component type", () => {
    const registry = new ComponentRegistry<Button | StringSelectMenu>();
    class WildcardButton extends Button {
      label = "button";
      customId = "__button_wildcard__";
      override customIdParser = (id: string) =>
        id === this.customId || id.startsWith("occomp:")
          ? { key: "*", data: {} }
          : parseCustomId(id);
    }
    class WildcardSelect extends StringSelectMenu {
      customId = "__select_wildcard__";
      options = [];
      override customIdParser = (id: string) =>
        id === this.customId || id.startsWith("occomp:")
          ? { key: "*", data: {} }
          : parseCustomId(id);
    }
    const button = new WildcardButton();
    const select = new WildcardSelect();

    registry.register(button);
    registry.register(select);

    expect(registry.resolve("occomp:cid=one", { componentType: ComponentType.Button })).toBe(
      button,
    );
    expect(registry.resolve("occomp:cid=one", { componentType: ComponentType.StringSelect })).toBe(
      select,
    );
  });

  it("uses each registered component parser when resolving specific keys", () => {
    const registry = new ComponentRegistry<Button>();
    class EncodedButton extends Button {
      label = "button";
      customId = "encoded:seed=one";
      override customIdParser = (id: string) => ({
        key: id.startsWith("encoded:") ? "encoded" : parseCustomId(id).key,
        data: {},
      });
    }
    const button = new EncodedButton();

    registry.register(button);

    expect(registry.resolve("encoded:payload=two", { componentType: ComponentType.Button })).toBe(
      button,
    );
  });

  it("caps oversized one-off component wait timers", () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const registry = new ComponentRegistry<Button>();

    void registry.waitForMessageComponent(
      { id: "message-1", channelId: "channel-1" } as never,
      Number.MAX_SAFE_INTEGER,
    );

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});

describe("Client.deployCommands", () => {
  it("bulk overwrites all guild commands for the same guild together", async () => {
    const client = createInternalTestClient([
      createTestCommand({ name: "one", guildIds: ["g1"] }),
      createTestCommand({ name: "two", guildIds: ["g1"] }),
    ]);
    const put = vi.fn(async () => undefined);
    attachRestMock(client, { put });

    await client.deployCommands({ mode: "overwrite" });

    expect(put).toHaveBeenCalledWith(Routes.applicationGuildCommands("app1", "g1"), {
      body: [
        {
          name: "one",
          description: "one command",
          type: ApplicationCommandType.ChatInput,
          integration_types: [0, 1],
          contexts: [0, 1, 2],
          default_member_permissions: null,
        },
        {
          name: "two",
          description: "two command",
          type: ApplicationCommandType.ChatInput,
          integration_types: [0, 1],
          contexts: [0, 1, 2],
          default_member_permissions: null,
        },
      ],
    });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("does not patch semantically unchanged nested command options", async () => {
    const client = createInternalTestClient([
      createTestCommand({
        name: "one",
        options: [{ type: 3, name: "value", description: "Value" }],
      }),
    ]);
    const get = vi.fn(async () => [
      {
        id: "cmd1",
        application_id: "app1",
        type: ApplicationCommandType.ChatInput,
        name: "one",
        description: "one command",
        options: [{ description: "Value", name: "value", type: 3 }],
        default_member_permissions: null,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
      },
    ]);
    const patch = vi.fn(async () => undefined);
    const post = vi.fn(async () => undefined);
    const deleteRequest = vi.fn(async () => undefined);
    attachRestMock(client, { get, patch, post, delete: deleteRequest });

    await client.deployCommands({ mode: "reconcile" });

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("does not patch live-only command metadata or reordered unordered arrays", async () => {
    const client = createInternalTestClient([
      createTestCommand({
        name: "one",
        options: [
          {
            type: 3,
            name: "value",
            description: "Value",
            required: false,
            autocomplete: false,
            channel_types: [1, 0],
          },
        ],
      }),
    ]);
    const get = vi.fn(async () => [
      {
        id: "cmd1",
        application_id: "app1",
        type: ApplicationCommandType.ChatInput,
        name: "one",
        name_localized: "one",
        description: "one command",
        description_localized: "one command",
        options: [
          {
            type: 3,
            name: "value",
            description: "Value",
            description_localized: "Value",
            channel_types: [0, 1],
          },
        ],
        default_member_permissions: null,
        dm_permission: true,
        integration_types: [1, 0],
        contexts: [2, 1, 0],
        guild_id: undefined,
        version: "1",
      },
    ]);
    const patch = vi.fn(async () => undefined);
    const post = vi.fn(async () => undefined);
    const deleteRequest = vi.fn(async () => undefined);
    attachRestMock(client, { get, patch, post, delete: deleteRequest });

    await client.deployCommands({ mode: "reconcile" });

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("bulk overwrites when a capped application cannot create a replacement", async () => {
    const retainedCommands = Array.from({ length: 99 }, (_, index) =>
      createTestCommand({ name: `retained-${index}` }),
    );
    const replacement = createTestCommand({ name: "replacement" });
    const client = createInternalTestClient([...retainedCommands, replacement]);
    const existing = [
      ...retainedCommands.map((command, index) =>
        Object.assign(command.serialize(), {
          id: `retained-id-${index}`,
          application_id: "app1",
        }),
      ),
      Object.assign(createTestCommand({ name: "stale" }).serialize(), {
        id: "stale-id",
        application_id: "app1",
      }),
    ];
    let deployedCount = existing.length;
    const operations: string[] = [];
    const get = vi.fn(async () => existing);
    const post = vi.fn(async () => {
      if (deployedCount >= 100) {
        throw new DiscordError(new Response(null, { status: 400 }), {
          message: "Maximum number of application commands reached (100).",
          code: 30032,
        });
      }
      deployedCount += 1;
      operations.push("post");
    });
    const put = vi.fn(async () => {
      deployedCount = 100;
      operations.push("put");
    });
    const deleteRequest = vi.fn(async () => undefined);
    attachRestMock(client, { get, post, put, delete: deleteRequest });

    await client.deployCommands({ mode: "reconcile" });

    expect(deleteRequest).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(Routes.applicationCommands("app1"), {
      body: replacement.serialize(),
    });
    expect(put).toHaveBeenCalledWith(Routes.applicationCommands("app1"), {
      body: [...retainedCommands, replacement].map((command) => command.serialize()),
    });
    expect(operations).toEqual(["put"]);
    expect(deployedCount).toBe(100);
  });

  it("keeps stale commands when a replacement create fails below the cap", async () => {
    const client = createInternalTestClient([createTestCommand({ name: "replacement" })]);
    const get = vi.fn(async () => [
      Object.assign(createTestCommand({ name: "stale" }).serialize(), {
        id: "stale-id",
        application_id: "app1",
      }),
    ]);
    const post = vi.fn(async () => {
      throw new Error("Discord unavailable");
    });
    const deleteRequest = vi.fn(async () => undefined);
    attachRestMock(client, { get, post, delete: deleteRequest });

    await expect(client.deployCommands({ mode: "reconcile" })).rejects.toThrow(
      "Discord unavailable",
    );

    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("patches changed option localization maps", async () => {
    const client = createInternalTestClient([
      createTestCommand({
        name: "one",
        options: [
          {
            type: 3,
            name: "value",
            name_localizations: { de: "wert" },
            description: "Value",
            description_localizations: { de: "Wert" },
          },
        ],
      }),
    ]);
    const get = vi.fn(async () => [
      {
        id: "cmd1",
        application_id: "app1",
        type: ApplicationCommandType.ChatInput,
        name: "one",
        description: "one command",
        options: [
          {
            type: 3,
            name: "value",
            name_localizations: { de: "alter-wert" },
            description: "Value",
            description_localizations: { de: "Alter Wert" },
          },
        ],
      },
    ]);
    const patch = vi.fn(async () => undefined);
    const post = vi.fn(async () => undefined);
    const deleteRequest = vi.fn(async () => undefined);
    attachRestMock(client, { get, patch, post, delete: deleteRequest });

    await client.deployCommands({ mode: "reconcile" });

    expect(patch).toHaveBeenCalledWith(Routes.applicationCommand("app1", "cmd1"), {
      body: {
        name: "one",
        description: "one command",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: 3,
            name: "value",
            name_localizations: { de: "wert" },
            description: "Value",
            description_localizations: { de: "Wert" },
          },
        ],
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        default_member_permissions: null,
      },
    });
    expect(post).not.toHaveBeenCalled();
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("skips command deploy when the serialized command set is unchanged", async () => {
    const client = createInternalTestClient([createTestCommand({ name: "one" })]);
    const get = vi.fn(async () => []);
    const post = vi.fn(async () => undefined);
    attachRestMock(client, { get, post });

    await client.deployCommands({ mode: "reconcile" });
    await client.deployCommands({ mode: "reconcile" });

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("skips unchanged command deploys across client restarts using the hash store", async () => {
    const hashStorePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-command-deploy-")),
      "hashes.json",
    );
    const first = createInternalTestClient([createTestCommand({ name: "one" })], {
      commandDeployHashStorePath: hashStorePath,
    });
    const firstGet = vi.fn(async () => []);
    const firstPost = vi.fn(async () => undefined);
    attachRestMock(first, { get: firstGet, post: firstPost });

    await first.deployCommands({ mode: "reconcile" });

    const second = createInternalTestClient([createTestCommand({ name: "one" })], {
      commandDeployHashStorePath: hashStorePath,
    });
    const secondGet = vi.fn(async () => []);
    const secondPost = vi.fn(async () => undefined);
    attachRestMock(second, { get: secondGet, post: secondPost });

    await second.deployCommands({ mode: "reconcile" });

    expect(firstGet).toHaveBeenCalledTimes(1);
    expect(firstPost).toHaveBeenCalledTimes(1);
    expect(secondGet).not.toHaveBeenCalled();
    expect(secondPost).not.toHaveBeenCalled();
  });

  it("caches REST object fetches briefly and invalidates from gateway updates", async () => {
    const client = createInternalTestClient();
    const get = vi.fn(async () => ({ id: "c1", type: 0, name: "general" }));
    attachRestMock(client, { get });

    await client.fetchChannel("c1");
    await client.fetchChannel("c1");
    expect(get).toHaveBeenCalledTimes(1);

    await client.dispatchGatewayEvent("CHANNEL_UPDATE", { id: "c1" });
    await client.fetchChannel("c1");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached REST objects while the process clock is invalid", async () => {
    const client = createInternalTestClient();
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: "c1", type: 0, name: "old" })
      .mockResolvedValueOnce({ id: "c1", type: 0, name: "fresh" })
      .mockResolvedValueOnce({ id: "c1", type: 0, name: "recovered" });
    attachRestMock(client, { get });

    const first = await client.fetchChannel("c1");
    expect(first.name).toBe("old");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const second = await client.fetchChannel("c1");

    expect(second.name).toBe("fresh");

    vi.mocked(Date.now).mockReturnValue(1_000);
    const third = await client.fetchChannel("c1");

    expect(third.name).toBe("recovered");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("does not cache REST objects when the cache expiry would exceed the Date range", async () => {
    const client = createInternalTestClient();
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: "c1", type: 0, name: "first" })
      .mockResolvedValueOnce({ id: "c1", type: 0, name: "second" });
    attachRestMock(client, { get });
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);

    const first = await client.fetchChannel("c1");
    const second = await client.fetchChannel("c1");

    expect(first.name).toBe("first");
    expect(second.name).toBe("second");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("Client gateway event queue", () => {
  function createQueuedClient(params: {
    listeners: AnyListener[];
    eventQueue?: ConstructorParameters<typeof Client>[0]["eventQueue"];
  }): Client {
    return new Client(
      {
        baseUrl: "http://localhost",
        clientId: "app1",
        publicKey: "public",
        token: "token",
        eventQueue: params.eventQueue,
      },
      { listeners: params.listeners },
    );
  }

  it("uses OpenClaw Discord event queue defaults", () => {
    const client = createQueuedClient({
      listeners: [],
      eventQueue: {},
    });

    expect(client.getRuntimeMetrics().eventQueue).toEqual({
      queueSize: 0,
      processing: 0,
      processed: 0,
      dropped: 0,
      timeouts: 0,
      maxQueueSize: 10_000,
      maxConcurrency: 50,
    });
  });

  it("times out hung queued listeners", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = {
      type: "READY",
      handle: vi.fn(async () => await new Promise<void>(() => {})),
    } satisfies AnyListener;
    const client = createQueuedClient({
      listeners: [listener],
      eventQueue: { listenerTimeout: 10, maxConcurrency: 1 },
    });

    const dispatch = client.dispatchGatewayEvent("READY", {});
    await vi.advanceTimersByTimeAsync(10);

    await expect(dispatch).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[EventQueue] Listener Object timed out after 10ms for event READY",
    );
    expect(client.getRuntimeMetrics().eventQueue).toEqual({
      queueSize: 0,
      processing: 0,
      processed: 1,
      dropped: 0,
      timeouts: 1,
      maxQueueSize: 10_000,
      maxConcurrency: 1,
    });
  });

  it("limits queued listener concurrency", async () => {
    const started: string[] = [];
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const first = {
      type: "READY",
      handle: vi.fn(async () => {
        started.push("first");
        await releaseFirst.promise;
      }),
    } satisfies AnyListener;
    const second = {
      type: "READY",
      handle: vi.fn(async () => {
        started.push("second");
        await releaseSecond.promise;
      }),
    } satisfies AnyListener;
    const client = createQueuedClient({
      listeners: [first, second],
      eventQueue: { maxConcurrency: 1, listenerTimeout: 1_000 },
    });

    const dispatch = client.dispatchGatewayEvent("READY", {});
    await vi.waitFor(() => expect(started).toEqual(["first"]));

    releaseFirst.resolve();
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    releaseSecond.resolve();
    await expect(dispatch).resolves.toBeUndefined();
  });

  it("rejects when queued listener work exceeds maxQueueSize", async () => {
    const releases: Array<() => void> = [];
    const listener = {
      type: "READY",
      handle: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      ),
    } satisfies AnyListener;
    const client = createQueuedClient({
      listeners: [listener],
      eventQueue: { maxConcurrency: 1, maxQueueSize: 1, listenerTimeout: 1_000 },
    });

    const first = client.dispatchGatewayEvent("READY", {});
    await vi.waitFor(() => expect(listener.handle).toHaveBeenCalledTimes(1));
    const second = client.dispatchGatewayEvent("READY", {});

    await expect(client.dispatchGatewayEvent("READY", {})).rejects.toThrow(
      "Discord event queue is full for READY; maxQueueSize=1",
    );

    releases.shift()?.();
    await vi.waitFor(() => expect(listener.handle).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });
});
