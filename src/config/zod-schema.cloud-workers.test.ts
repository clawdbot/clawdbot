// Verifies cloud-worker provider profile config parsing.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function parseCloudWorkers(value: unknown) {
  const result = OpenClawSchema.safeParse({ cloudWorkers: value });
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data.cloudWorkers;
}

describe("OpenClawSchema cloudWorkers config", () => {
  it("is absent by default and accepts an empty opt-in block", () => {
    expect(OpenClawSchema.parse({}).cloudWorkers).toBeUndefined();
    expect(parseCloudWorkers({})).toStrictEqual({});
  });

  it("accepts provider-owned settings and stored lifetime policy", () => {
    expect(
      parseCloudWorkers({
        profiles: {
          development: {
            provider: "static-ssh",
            settings: {
              host: "worker.example.test",
              port: 22,
              user: "openclaw",
              keyRef: {
                source: "file",
                provider: "default",
                id: "/cloud-workers/development/privateKey",
              },
            },
            lifetime: {
              idleTimeoutMinutes: 60,
              maxLifetimeMinutes: 1440,
            },
          },
        },
      }),
    ).toStrictEqual({
      profiles: {
        development: {
          provider: "static-ssh",
          install: "bundle",
          settings: {
            host: "worker.example.test",
            port: 22,
            user: "openclaw",
            keyRef: {
              source: "file",
              provider: "default",
              id: "/cloud-workers/development/privateKey",
            },
          },
          lifetime: {
            idleTimeoutMinutes: 60,
            maxLifetimeMinutes: 1440,
          },
        },
      },
    });
  });

  it("accepts npm as an explicit install method", () => {
    expect(
      parseCloudWorkers({
        profiles: {
          released: {
            provider: "qa-lab",
            install: "npm",
          },
        },
      }),
    ).toStrictEqual({
      profiles: {
        released: {
          provider: "qa-lab",
          install: "npm",
        },
      },
    });
  });

  it.each([
    { profiles: { development: { provider: "" } } },
    { profiles: { development: { provider: "qa-lab", install: "git" } } },
    { profiles: { " development ": { provider: "qa-lab" } } },
    { profiles: { development: { provider: "qa-lab", settings: { timeout: Infinity } } } },
    { profiles: { development: { provider: "qa-lab", settings: { region: undefined } } } },
    {
      profiles: {
        development: { provider: "qa-lab", settings: { keyRef: "plain-private-key" } },
      },
    },
    {
      profiles: {
        development: { provider: "qa-lab", settings: { auth: { apiKey: "plain-api-key" } } },
      },
    },
    { profiles: { development: { provider: "qa-lab", lifetime: { idleTimeoutMinutes: 0 } } } },
    {
      profiles: {
        development: { provider: "qa-lab", lifetime: { maxLifetimeMinutes: 1.5 } },
      },
    },
    { profiles: { development: { provider: "qa-lab", unsupported: true } } },
  ])("rejects invalid core profile fields %#", (cloudWorkers) => {
    expect(OpenClawSchema.safeParse({ cloudWorkers }).success).toBe(false);
  });
});
