import { ApplicationCommandType, ComponentType, Routes } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, ComponentRegistry, type AnyListener } from "./client.js";
import { BaseCommand } from "./commands.js";
import { Button, StringSelectMenu, parseCustomId } from "./components.js";
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
    description = `${params.name} command`;
    type = ApplicationCommandType.ChatInput;
    guildIds = params.guildIds;
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
      customIdParser = (id: string) =>
        id === this.customId || id.startsWith("occomp:")
          ? { key: "*", data: {} }
          : parseCustomId(id);
    }
    class WildcardSelect extends StringSelectMenu {
      customId = "__select_wildcard__";
      options = [];
      customIdParser = (id: string) =>
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
      customIdParser = (id: string) => ({
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
      body: [expect.objectContaining({ name: "one" }), expect.objectContaining({ name: "two" })],
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

    expect(client.getRuntimeMetrics().eventQueue).toEqual(
      expect.objectContaining({
        maxQueueSize: 10_000,
        maxConcurrency: 50,
      }),
    );
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
    expect(client.getRuntimeMetrics().eventQueue).toEqual(
      expect.objectContaining({ processed: 1, timeouts: 1 }),
    );
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
