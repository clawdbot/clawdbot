// Verifies cloud-worker provider profile config parsing.
import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { CLOUD_WORKER_FIELD_HELP, CLOUD_WORKER_FIELD_LABELS } from "./zod-schema.cloud-workers.js";
import { OpenClawSchema } from "./zod-schema.js";

function parseCloudWorkers(value: unknown) {
  const result = OpenClawSchema.safeParse({ cloudWorkers: value });
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data.cloudWorkers;
}

describe("OpenClawSchema cloudWorkers config", () => {
  it("derives cloud worker labels and help from the field schemas", () => {
    const response = computeBaseConfigSchemaResponse({ generatedAt: "cloud-worker-metadata" });
    const properties = (
      response.schema as {
        properties?: {
          cloudWorkers?: {
            title?: string;
            description?: string;
            properties?: {
              desktop?: {
                title?: string;
                description?: string;
              };
              profiles?: {
                title?: string;
                description?: string;
                additionalProperties?: {
                  title?: string;
                  description?: string;
                  properties?: Record<string, { title?: string; description?: string }>;
                };
              };
            };
          };
        };
      }
    ).properties?.cloudWorkers;
    const desktop = properties?.properties?.desktop;
    const profiles = properties?.properties?.profiles;
    const profile = profiles?.additionalProperties;

    for (const [path, schema] of [
      ["cloudWorkers.desktop", desktop],
      ["cloudWorkers.profiles", profiles],
      ["cloudWorkers.profiles.*", profile],
      ["cloudWorkers.profiles.*.provider", profile?.properties?.provider],
      ["cloudWorkers.profiles.*.install", profile?.properties?.install],
      ["cloudWorkers.profiles.*.settings", profile?.properties?.settings],
    ] as const) {
      expect(schema?.title, path).toBe(CLOUD_WORKER_FIELD_LABELS[path]);
      expect(schema?.description, path).toBe(CLOUD_WORKER_FIELD_HELP[path]);
      expect(response.uiHints[path]?.label, path).toBe(schema?.title);
      expect(response.uiHints[path]?.help, path).toBe(schema?.description);
    }
  });

  it("is absent by default and accepts an empty opt-in block", () => {
    expect(OpenClawSchema.parse({}).cloudWorkers).toBeUndefined();
    expect(parseCloudWorkers({})).toStrictEqual({});
  });

  it("accepts the desktop Labs gate only as a boolean", () => {
    expect(parseCloudWorkers({ desktop: true })).toStrictEqual({ desktop: true });
    expect(OpenClawSchema.safeParse({ cloudWorkers: { desktop: "true" } }).success).toBe(false);
  });

  it("accepts provider-owned settings", () => {
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
        },
      },
    });
  });

  it("defaults a minimal Crabbox profile to bundle installation", () => {
    expect(
      parseCloudWorkers({
        profiles: {
          aws: {
            provider: "crabbox",
            settings: {
              provider: "aws",
              class: "standard",
              ttl: "8h",
              idleTimeout: "45m",
            },
          },
        },
      }),
    ).toStrictEqual({
      profiles: {
        aws: {
          provider: "crabbox",
          install: "bundle",
          settings: {
            provider: "aws",
            class: "standard",
            ttl: "8h",
            idleTimeout: "45m",
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
