import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ComposerMicrophonePicker } from "./composer-microphone-picker.ts";

function catalog(ready: boolean) {
  return {
    realtime: { ready, providers: [] },
    transcription: { ready, providers: [] },
  };
}

let picker: ComposerMicrophonePicker;

afterEach(() => picker?.dispose());

describe("composer voice readiness", () => {
  it("refreshes after returning from login on the same Gateway connection", async () => {
    const request = vi.fn().mockResolvedValueOnce(catalog(false)).mockResolvedValue(catalog(true));
    const client = { request } as unknown as GatewayBrowserClient;
    picker = new ComposerMicrophonePicker(vi.fn());
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
    expect(picker.dictationStatus).toBe("ready");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("talk.catalog", {});
    expect(picker.open).toBe(false);
  });

  it("retires focus requests on disposal and reconnects a reused picker without stale results", async () => {
    const stale = createDeferred<ReturnType<typeof catalog>>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(catalog(false))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(catalog(true));
    const client = { request } as unknown as GatewayBrowserClient;
    const requestUpdate = vi.fn();
    picker = new ComposerMicrophonePicker(requestUpdate);
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(2);

    picker.dispose();
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(2);
    expect(picker.realtimeStatus).toBe("unknown");

    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
    requestUpdate.mockClear();
    stale.resolve(catalog(false));
    await stale.promise;
    await Promise.resolve();
    expect(picker.realtimeStatus).toBe("ready");
    expect(requestUpdate).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(4);
    picker.syncCatalog(client, false);
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(4);
  });
});
