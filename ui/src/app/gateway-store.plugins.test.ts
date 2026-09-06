import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

beforeEach(stubGatewayStoreTestGlobals);
afterEach(() => vi.unstubAllGlobals());

it("refreshes plugin methods and surfaces on the existing connection", async () => {
  const { gateway, clients, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  const sessionKey = gateway.snapshot.sessionKey;
  const capabilities = {
    ok: true,
    generation: 7,
    descriptors: [],
    methods: ["plugins.reload", "plugin.notes.read"],
    controlUiTabs: [{ pluginId: "notes", id: "notes", label: "Notes" }],
    controlUiWidgetKinds: [{ pluginId: "notes", kind: "notes:card", label: "Note" }],
    pluginSurfaceUrls: {},
  };
  current().request.mockResolvedValue(capabilities);
  current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 7 }));
  await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(7));
  expect(gateway.snapshot.hello).toMatchObject({
    features: { methods: capabilities.methods },
    controlUiTabs: capabilities.controlUiTabs,
    controlUiWidgetKinds: capabilities.controlUiWidgetKinds,
  });
  current().request.mockResolvedValue({
    ...capabilities,
    generation: 8,
    methods: ["plugins.reload"],
    controlUiTabs: [],
    controlUiWidgetKinds: [],
  });
  current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 8 }));
  await vi.waitFor(() => expect(gateway.snapshot.hello?.controlUiTabs).toEqual([]));
  expect(gateway.snapshot.sessionKey).toBe(sessionKey);
  expect(gateway.snapshot.phase).toBe("connected");
  expect(clients).toHaveLength(1);
  expect(current().stopped).toBe(0);
  gateway.stop();
});

it("discards a capability response from a retired connection", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  let resolve!: (value: unknown) => void;
  current().request.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 7 }));
  await vi.waitFor(() =>
    expect(current().request).toHaveBeenCalledWith("plugins.uiDescriptors", {}),
  );
  gateway.connect();
  current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  resolve({
    ok: true,
    generation: 7,
    descriptors: [],
    methods: ["plugin.retired.read"],
    controlUiTabs: [],
    controlUiWidgetKinds: [],
    pluginSurfaceUrls: {},
  });
  await Promise.resolve();
  expect(gateway.snapshot.pluginCapabilities).toBeNull();
  expect(gateway.snapshot.hello?.features?.methods).toBeUndefined();
  gateway.stop();
});

it("keeps the latest capability refresh through invalid events and older failures", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  current().request.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const capabilities = (generation: number) => ({
    ok: true,
    generation,
    descriptors: [],
    methods: ["plugins.reload"],
    controlUiTabs: [],
    controlUiWidgetKinds: [],
    pluginSurfaceUrls: {},
  });
  const changed = (generation: unknown) =>
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation }));

  changed(7);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  changed("invalid");
  await vi.dynamicImportSettled();
  expect(pending).toHaveLength(1);
  pending[0]!.resolve(capabilities(7));
  await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(7));

  changed(8);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  changed(9);
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  pending[2]!.resolve(capabilities(9));
  await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(9));
  pending[1]!.reject(new Error("superseded capability request"));
  await vi.dynamicImportSettled();
  expect(gateway.snapshot.pluginCapabilities?.generation).toBe(9);
  expect(gateway.snapshot.lastError).toBeNull();
  gateway.stop();
});
