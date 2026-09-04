import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider, WorkerSshIdentity } from "../../plugins/types.js";
import { resolveWorkerSshIdentity } from "./identity.js";

const KEY_REF = { source: "file", provider: "worker", id: "/lease" } as const;
const PROFILE = { provider: "example" };

function provider(overrides: Partial<WorkerProvider> = {}): WorkerProvider {
  return {
    id: "example",
    resolveAllocation: vi.fn(),
    provision: vi.fn(),
    inspect: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

describe("resolveWorkerSshIdentity", () => {
  it("uses the provider-owned resolver with durable lease context", async () => {
    const identity: WorkerSshIdentity = { kind: "path", path: "/keys/lease" };
    const resolveSshIdentity = vi.fn(async () => identity);
    const resolveGeneric = vi.fn(async () => ({ kind: "material", contents: "unused" }) as const);
    const assertAuthorized = vi.fn();

    await expect(
      resolveWorkerSshIdentity({
        provider: provider({ resolveSshIdentity }),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized,
        resolveGeneric,
      }),
    ).resolves.toEqual(identity);

    expect(resolveSshIdentity).toHaveBeenCalledWith({
      leaseId: "lease-1",
      profile: PROFILE,
      keyRef: KEY_REF,
      assertAuthorized,
    });
    expect(assertAuthorized).toHaveBeenCalledTimes(2);
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it("uses the generic resolver when the provider has no resolver", async () => {
    const identity: WorkerSshIdentity = {
      kind: "material",
      contents: ["part", "value"].join("-"),
    };
    const resolveGeneric = vi.fn(async () => identity);
    const assertAuthorized = vi.fn();

    await expect(
      resolveWorkerSshIdentity({
        provider: provider(),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized,
        resolveGeneric,
      }),
    ).resolves.toEqual(identity);
    expect(resolveGeneric).toHaveBeenCalledWith(KEY_REF, assertAuthorized);
    expect(assertAuthorized).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the provider resolver rejects", async () => {
    const resolveGeneric = vi.fn();

    await expect(
      resolveWorkerSshIdentity({
        provider: provider({
          resolveSshIdentity: async () => {
            throw new Error("provider identity unavailable");
          },
        }),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized: vi.fn(),
        resolveGeneric,
      }),
    ).rejects.toThrow("provider identity unavailable");
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it.each(["provider", "generic"] as const)(
    "rejects a %s identity that resolves after authority closes",
    async (owner) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = vi.fn();
      let authorized = true;
      const assertAuthorized = () => {
        if (!authorized) {
          throw new Error("worker identity authority closed");
        }
      };
      const resolve = async () => {
        entered();
        await pending;
        return { kind: "path" as const, path: "/keys/lease" };
      };
      const resolveGeneric = vi.fn(resolve);

      const operation = resolveWorkerSshIdentity({
        provider: provider(owner === "provider" ? { resolveSshIdentity: resolve } : {}),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized,
        resolveGeneric,
      });
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      authorized = false;
      release();

      await expect(operation).rejects.toThrow("worker identity authority closed");
      expect(resolveGeneric).toHaveBeenCalledTimes(owner === "generic" ? 1 : 0);
    },
  );
});
