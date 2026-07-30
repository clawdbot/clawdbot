import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider, WorkerSshIdentity } from "../../plugins/types.js";
import { resolveWorkerSshIdentity } from "./identity.js";

const KEY_REF = { source: "file", provider: "worker", id: "/lease" } as const;
const PROFILE = { provider: "example" };

function provider(overrides: Partial<WorkerProvider> = {}): WorkerProvider {
  return {
    id: "example",
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

    await expect(
      resolveWorkerSshIdentity({
        provider: provider({ resolveSshIdentity }),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        resolveGeneric,
      }),
    ).resolves.toEqual(identity);

    expect(resolveSshIdentity).toHaveBeenCalledWith({
      leaseId: "lease-1",
      profile: PROFILE,
      keyRef: KEY_REF,
    });
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it("uses the generic resolver when the provider has no resolver", async () => {
    const identity: WorkerSshIdentity = {
      kind: "material",
      contents: ["part", "value"].join("-"),
    };
    const resolveGeneric = vi.fn(async () => identity);

    await expect(
      resolveWorkerSshIdentity({
        provider: provider(),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        resolveGeneric,
      }),
    ).resolves.toEqual(identity);
    expect(resolveGeneric).toHaveBeenCalledWith(KEY_REF);
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
        resolveGeneric,
      }),
    ).rejects.toThrow("provider identity unavailable");
    expect(resolveGeneric).not.toHaveBeenCalled();
  });
});
