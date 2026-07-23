// Signal tests cover concrete transport routing in the client adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client-adapter.js";
import * as containerClient from "./client-container.js";
import * as nativeClient from "./client.js";

const nativeCheck = vi.fn<typeof nativeClient.signalCheck>();
const nativeRpc = vi.fn<typeof nativeClient.signalRpcRequest>();
const nativeStream = vi.fn<typeof nativeClient.streamSignalEvents>();
const containerCheck = vi.fn<typeof containerClient.containerCheck>();
const containerRpc = vi.fn<typeof containerClient.containerRpcRequest>();
const containerStream = vi.fn<typeof containerClient.streamContainerEvents>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(nativeClient, "signalCheck").mockImplementation(nativeCheck);
  vi.spyOn(nativeClient, "signalRpcRequest").mockImplementation(nativeRpc);
  vi.spyOn(nativeClient, "streamSignalEvents").mockImplementation(nativeStream);
  vi.spyOn(containerClient, "containerCheck").mockImplementation(containerCheck);
  vi.spyOn(containerClient, "containerRpcRequest").mockImplementation(containerRpc);
  vi.spyOn(containerClient, "streamContainerEvents").mockImplementation(containerStream);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signalRpcRequest", () => {
  it.each(["managed-native", "external-native"] as const)(
    "routes %s through native JSON-RPC",
    async (transportKind) => {
      nativeRpc.mockResolvedValue({ timestamp: 17 });

      await expect(
        signalRpcRequest(
          "send",
          { message: "Hello", recipient: ["+15550001111"] },
          { baseUrl: "http://native:8080", transportKind },
        ),
      ).resolves.toEqual({ timestamp: 17 });
      expect(nativeRpc).toHaveBeenCalledWith(
        "send",
        { message: "Hello", recipient: ["+15550001111"] },
        expect.objectContaining({ baseUrl: "http://native:8080", transportKind }),
      );
      expect(containerRpc).not.toHaveBeenCalled();
    },
  );

  it("routes container through REST", async () => {
    containerRpc.mockResolvedValue({ timestamp: 17 });

    await expect(
      signalRpcRequest(
        "send",
        { message: "Hello", recipient: ["+15550001111"] },
        { baseUrl: "http://container:8080", transportKind: "container" },
      ),
    ).resolves.toEqual({ timestamp: 17 });
    expect(containerRpc).toHaveBeenCalledWith(
      "send",
      { message: "Hello", recipient: ["+15550001111"] },
      { baseUrl: "http://container:8080", transportKind: "container" },
    );
    expect(nativeRpc).not.toHaveBeenCalled();
  });
});

describe("signalCheck", () => {
  it("probes only the configured native endpoint", async () => {
    nativeCheck.mockResolvedValue({ ok: true, status: 200 });

    await expect(
      signalCheck("http://native:8080", 5_000, { transportKind: "external-native" }),
    ).resolves.toEqual({ ok: true, status: 200 });
    expect(nativeCheck).toHaveBeenCalledWith("http://native:8080", 5_000);
    expect(containerCheck).not.toHaveBeenCalled();
  });

  it("probes only the configured container endpoint", async () => {
    containerCheck.mockResolvedValue({ ok: true, status: 200 });

    await expect(
      signalCheck("http://container:8080", 5_000, { transportKind: "container" }),
    ).resolves.toEqual({ ok: true, status: 200 });
    expect(containerCheck).toHaveBeenCalledWith("http://container:8080", 5_000);
    expect(nativeCheck).not.toHaveBeenCalled();
  });
});

describe("streamSignalEvents", () => {
  it("uses native SSE for managed and external native transports", async () => {
    nativeStream.mockImplementation(async (params) => {
      params.onEvent({ event: "receive", data: "native" });
    });
    const onEvent = vi.fn();

    await streamSignalEvents({
      baseUrl: "http://native:8080",
      account: "+15555550123",
      transportKind: "managed-native",
      timeoutMs: 0,
      onEvent,
    });

    expect(nativeStream).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://native:8080",
        account: "+15555550123",
        timeoutMs: 0,
      }),
    );
    expect(onEvent).toHaveBeenCalledWith({ event: "receive", data: "native" });
    expect(containerStream).not.toHaveBeenCalled();
  });

  it("uses the container WebSocket and converts its event shape", async () => {
    containerStream.mockImplementation(async (params) => {
      params.onEvent({ envelope: { sourceNumber: "+15555550124" } });
    });
    const onEvent = vi.fn();

    await streamSignalEvents({
      baseUrl: "http://container:8080",
      account: "+15555550123",
      transportKind: "container",
      onEvent,
    });

    expect(containerStream).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://container:8080",
        account: "+15555550123",
      }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      event: "receive",
      data: JSON.stringify({ envelope: { sourceNumber: "+15555550124" } }),
    });
    expect(nativeStream).not.toHaveBeenCalled();
  });
});
