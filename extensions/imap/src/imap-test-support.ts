import type { AuthenticateResult } from "mailauth";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { createImapState } from "./state.js";

export function createImapTestRuntime() {
  const namespaces = new Map<string, Map<string, unknown>>();
  const dispatchHookAgentTurn = vi.fn(async () => ({ ok: true as const, runId: "mail-run" }));
  const runtime = createPluginRuntimeMock({
    hooks: { dispatchHookAgentTurn },
    state: {
      openKeyedStore: <T>(options: { namespace: string }) => {
        let values = namespaces.get(options.namespace);
        if (!values) {
          values = new Map();
          namespaces.set(options.namespace, values);
        }
        const entries = values;
        return {
          register: async (key: string, value: T) => void entries.set(key, value),
          registerIfAbsent: async (key: string, value: T) => {
            if (entries.has(key)) {
              return false;
            }
            entries.set(key, value);
            return true;
          },
          lookup: async (key: string) => entries.get(key) as T | undefined,
          consume: async (key: string) => {
            const value = entries.get(key) as T | undefined;
            entries.delete(key);
            return value;
          },
          delete: async (key: string) => entries.delete(key),
          entries: async () =>
            [...entries].map(([key, value]) => ({ key, value: value as T, createdAt: 0 })),
          clear: async () => entries.clear(),
        };
      },
    },
  });
  return { runtime, state: createImapState(runtime), dispatchHookAgentTurn };
}

type AuthenticationStatus = Exclude<AuthenticateResult["dmarc"], false>["status"]["result"];

export function createImapAuthResult(
  dmarc: AuthenticationStatus,
  spf: AuthenticationStatus = "none",
): AuthenticateResult {
  return {
    dkim: { headerFrom: ["example.com"], envelopeFrom: false, results: [] },
    spf: {
      domain: "example.com",
      "client-ip": "127.0.0.1",
      status: { result: spf },
      header: "",
      info: "",
    },
    dmarc: {
      domain: "example.com",
      policy: "none",
      p: "none",
      sp: "none",
      status: { result: dmarc },
      alignment: { spf: { strict: false }, dkim: { strict: false } },
      info: "",
    },
    arc: false,
    bimi: false,
    headers: "",
  };
}
