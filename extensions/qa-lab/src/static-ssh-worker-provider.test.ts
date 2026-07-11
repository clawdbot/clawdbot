// QA Lab tests cover deterministic static-SSH worker provider behavior.
import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  createStaticSshWorkerProvider,
  STATIC_SSH_WORKER_PROVIDER_ID,
} from "./static-ssh-worker-provider.js";

const KEY_REF = {
  source: "file" as const,
  provider: "default",
  id: "/cloud-workers/development/private-key",
};
const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const PROFILE = {
  host: "worker.example.test",
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: KEY_REF,
};

describe("QA Lab static-SSH worker provider", () => {
  it("provisions a deterministic logical lease with the default SSH port", async () => {
    const provider = createStaticSshWorkerProvider();
    const profile = {
      host: " worker.example.test ",
      user: " openclaw ",
      hostKey: ` ${HOST_KEY} `,
      keyRef: KEY_REF,
    };

    const first = await provider.provision(profile, "operation-123");
    const replay = await provider.provision(profile, "operation-123");

    expect(provider.id).toBe(STATIC_SSH_WORKER_PROVIDER_ID);
    expect(first).toStrictEqual({
      leaseId: "static-ssh:operation-123",
      ssh: {
        host: "worker.example.test",
        port: 22,
        user: "openclaw",
        hostKey: HOST_KEY,
        keyRef: KEY_REF,
      },
    });
    expect(replay).toStrictEqual(first);
  });

  it("preserves an explicit positive SSH port", async () => {
    const provider = createStaticSshWorkerProvider();

    await expect(
      provider.provision({ ...PROFILE, port: 2222 }, "operation-456"),
    ).resolves.toMatchObject({ ssh: { port: 2222 } });
  });

  it.each<{ label: string; profile: WorkerProfile }>([
    { label: "host", profile: { ...PROFILE, host: " " } },
    { label: "user", profile: { ...PROFILE, user: "" } },
    {
      label: "port",
      profile: { ...PROFILE, port: 0 },
    },
    {
      label: "port",
      profile: { ...PROFILE, port: 1.5 },
    },
    {
      label: "port",
      profile: { ...PROFILE, port: 65_536 },
    },
    {
      label: "keyRef",
      profile: { ...PROFILE, keyRef: "plaintext-key" },
    },
    {
      label: "keyRef",
      profile: { host: PROFILE.host, user: PROFILE.user, hostKey: HOST_KEY },
    },
    {
      label: "keyRef",
      profile: {
        ...PROFILE,
        keyRef: { source: "file", provider: "", id: "/private-key" },
      },
    },
    {
      label: "keyRef",
      profile: {
        ...PROFILE,
        keyRef: { source: "file", provider: "default", id: "private-key" },
      },
    },
    {
      label: "keyRef",
      profile: {
        ...PROFILE,
        keyRef: { source: "env", provider: "default", id: "lowercase" },
      },
    },
    {
      label: "keyRef",
      profile: {
        ...PROFILE,
        keyRef: { source: "exec", provider: "vault", id: "../private-key" },
      },
    },
    {
      label: "hostKey",
      profile: { host: PROFILE.host, user: PROFILE.user, keyRef: KEY_REF },
    },
    { label: "hostKey", profile: { ...PROFILE, hostKey: " " } },
    { label: "hostKey", profile: { ...PROFILE, hostKey: 42 } },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: [HOST_KEY, HOST_KEY].join("\n") },
    },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: ["restrict", HOST_KEY].join(" ") },
    },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: [HOST_KEY, "comment"].join(" ") },
    },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: ["not-a-key-type", "AAAA"].join(" ") },
    },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: ["ssh-ed25519", "not-base64!"].join(" ") },
    },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: ["ssh-ed25519", "A"].join(" ") },
    },
    {
      label: "hostKey",
      profile: { ...PROFILE, hostKey: [HOST_KEY, "x".repeat(16_384)].join(" ") },
    },
  ])("rejects an invalid $label", async ({ label, profile }) => {
    const provider = createStaticSshWorkerProvider();

    await expect(provider.provision(profile, "operation-invalid")).rejects.toThrow(label);
    await expect(provider.provision(profile, "operation-invalid")).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("reports only its deterministic lease ids as active", async () => {
    const provider = createStaticSshWorkerProvider();

    await expect(
      provider.inspect({ leaseId: "static-ssh:operation-123", profile: PROFILE }),
    ).resolves.toStrictEqual({
      status: "active",
    });
    await expect(
      provider.inspect({ leaseId: "static-ssh:", profile: PROFILE }),
    ).resolves.toStrictEqual({ status: "unknown" });
    await expect(
      provider.inspect({ leaseId: "other:operation-123", profile: PROFILE }),
    ).resolves.toStrictEqual({ status: "unknown" });
  });

  it("destroys logical leases idempotently", async () => {
    const provider = createStaticSshWorkerProvider();

    const lease = { leaseId: "static-ssh:operation-123", profile: PROFILE };
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
  });
});
