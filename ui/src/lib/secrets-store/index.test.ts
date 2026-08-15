import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  bulkSetSecretsStoreEntries,
  createInitialSecretsStoreState,
  parseSecretsStoreBulkInput,
  setSecretsStoreEntry,
} from "./index.ts";

function clientWithResponses(responses: unknown[]) {
  const request = vi.fn(async (_method: string, _params?: unknown) => responses.shift());
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

describe("secrets store state", () => {
  it("parses quoted multiline dotenv values and classifies sensitive names", () => {
    const parsed = parseSecretsStoreBulkInput(
      'SERVICE_URL="https://service.test?a=b"\nSERVICE_API_KEY="line one\nline two"\nPLAIN=value',
      true,
    );
    expect(parsed).toEqual({
      entries: [
        { name: "SERVICE_URL", value: "https://service.test?a=b", kind: "env" },
        { name: "SERVICE_API_KEY", value: "line one\nline two", kind: "secret" },
        { name: "PLAIN", value: "value", kind: "env" },
      ],
      invalidNames: [],
    });
    expect(parseSecretsStoreBulkInput("SERVICE_API_KEY=value", false).entries[0]?.kind).toBe("env");
  });

  it("reloads the canonical list after a set", async () => {
    const snapshot = {
      entries: [
        {
          name: "SERVICE_URL",
          kind: "env",
          value: "https://service.test",
          scopeKind: "team",
          scopeId: "",
          createdAtMs: 1,
          updatedAtMs: 2,
          updatedBy: "Control UI",
        },
      ],
    };
    const { client, request } = clientWithResponses([{ ok: true, reloaded: false }, snapshot]);
    const state = createInitialSecretsStoreState({ client, connected: true });

    await setSecretsStoreEntry(state, {
      name: "SERVICE_URL",
      value: "https://service.test",
      kind: "env",
      allowedHosts: "",
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.store.set",
      "secrets.store.list",
    ]);
    expect(state.entries).toEqual(snapshot.entries);
    expect(state.error).toBeNull();
  });

  it("reloads after every sequential bulk set", async () => {
    const { client, request } = clientWithResponses([
      { ok: true, reloaded: false },
      { entries: [] },
      { ok: true, reloaded: false },
      { entries: [] },
    ]);
    const state = createInitialSecretsStoreState({ client, connected: true });

    expect(
      await bulkSetSecretsStoreEntries(state, [
        { name: "ONE", value: "1", kind: "env" },
        { name: "TWO_TOKEN", value: "2", kind: "secret" },
      ]),
    ).toEqual({ saved: 2, warningCount: 0 });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.store.set",
      "secrets.store.list",
      "secrets.store.set",
      "secrets.store.list",
    ]);
  });

  it("sends parsed allowed hosts through the store RPC", async () => {
    const { client, request } = clientWithResponses([
      { ok: true, reloaded: false },
      { entries: [] },
    ]);
    const state = createInitialSecretsStoreState({ client, connected: true });

    await setSecretsStoreEntry(state, {
      name: "SERVICE_API_KEY",
      value: "secret",
      kind: "secret",
      allowedHosts: "api.example.com, uploads.example.com\napi2.example.com",
    });

    expect(request).toHaveBeenNthCalledWith(1, "secrets.store.set", {
      name: "SERVICE_API_KEY",
      value: "secret",
      kind: "secret",
      allowedHosts: ["api.example.com", "uploads.example.com", "api2.example.com"],
    });
  });
});
