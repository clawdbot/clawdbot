import { describe, expect, it } from "vitest";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  cloudWorkerProfileStatus,
  createCloudWorkerDraft,
  readCloudWorkerProfiles,
  validateCloudWorkerDraft,
} from "./cloud-worker-config.ts";

const configuredProfile = {
  provider: "crabbox",
  install: "npm",
  label: "preserved",
  settings: {
    provider: "aws",
    class: "beast",
    ttl: "24h",
    idleTimeout: "60m",
    setup: "install-node",
    setupEnv: ["OPENCLAW_WORKER_ARTIFACT_TOKEN"],
    desktop: true,
    binary: "/opt/crabbox",
    region: "eu-west-1",
  },
};

describe("cloud worker settings state", () => {
  it("distinguishes empty, advertised, and restart-required profiles", () => {
    expect(readCloudWorkerProfiles({})).toEqual([]);
    expect(
      readCloudWorkerProfiles({ cloudWorkers: { profiles: { production: configuredProfile } } }),
    ).toEqual([
      {
        id: "production",
        providerId: "crabbox",
        install: "npm",
        backend: "aws",
        machineClass: "beast",
        ttl: "24h",
        idleTimeout: "60m",
        setup: "install-node",
        desktop: true,
        binary: "/opt/crabbox",
      },
    ]);
    expect(cloudWorkerProfileStatus("production", new Set(), false)).toBe("loading");
    expect(cloudWorkerProfileStatus("production", new Set(["production"]), true)).toBe(
      "advertised",
    );
    expect(cloudWorkerProfileStatus("production", new Set(), true)).toBe("restart-required");
  });

  it.each([
    ["profileId", { id: "bad id" }],
    ["profileExists", { id: "production" }],
    ["backend", { backend: " " }],
    ["machineClass", { machineClass: "" }],
    ["machineClass", { machineClass: "x".repeat(129) }],
    ["ttl", { ttl: "tomorrow" }],
    ["idleTimeout", { idleTimeout: "0m" }],
    ["binary", { binary: "relative/crabbox" }],
  ] as const)("returns %s for an invalid add draft", (expected, patch) => {
    const draft = { ...createCloudWorkerDraft(), id: "new-profile", backend: "hetzner", ...patch };
    expect(validateCloudWorkerDraft(draft, { production: configuredProfile }, null)).toBe(expected);
  });

  it("builds a full edit patch with tombstones while preserving unknown fields", () => {
    const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
    const draft = {
      ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
      backend: "hetzner",
      machineClass: "large",
      ttl: "8h",
      idleTimeout: "45m",
      setup: "",
      desktop: false,
      binary: "",
    };

    expect(buildCloudWorkerUpsertPatch(config, draft, "production")).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            production: {
              provider: "crabbox",
              install: "npm",
              label: "preserved",
              settings: {
                provider: "hetzner",
                class: "large",
                ttl: "8h",
                idleTimeout: "45m",
                setup: null,
                setupEnv: null,
                desktop: null,
                binary: null,
                region: "eu-west-1",
              },
            },
          },
        },
      },
    });
  });

  it("preserves forwarded setup environment while its setup command remains configured", () => {
    const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
    const draft = createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]);

    expect(buildCloudWorkerUpsertPatch(config, draft, "production")).toMatchObject({
      patch: {
        cloudWorkers: {
          profiles: {
            production: {
              settings: {
                setup: "install-node",
                setupEnv: ["OPENCLAW_WORKER_ARTIFACT_TOKEN"],
              },
            },
          },
        },
      },
    });
  });

  it.each([undefined, []])("keeps empty setup environment unchanged (%j)", (setupEnv) => {
    const existingSettings = Object.fromEntries(
      Object.entries(configuredProfile.settings).filter(
        ([key]) => key !== "setupEnv" || setupEnv !== undefined,
      ),
    );
    if (setupEnv) {
      existingSettings.setupEnv = setupEnv;
    }
    const profile = { ...configuredProfile, settings: existingSettings };
    const config = { cloudWorkers: { profiles: { production: profile } } };
    const draft = { ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]), setup: "" };

    expect(buildCloudWorkerUpsertPatch(config, draft, "production")).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            production: { ...profile, settings: { ...existingSettings, setup: null } },
          },
        },
      },
    });
  });

  it("rejects an edit after its authoritative profile changes provider", () => {
    const config = {
      cloudWorkers: {
        profiles: {
          production: {
            provider: "static-ssh",
            settings: { host: "worker.example.test", user: "openclaw" },
          },
        },
      },
    };
    const draft = createCloudWorkerDraft({
      id: "production",
      providerId: "crabbox",
      install: "bundle",
      backend: "aws",
      machineClass: "standard",
      ttl: "8h",
      idleTimeout: "45m",
      setup: "",
      desktop: false,
      binary: "",
    });

    expect(buildCloudWorkerUpsertPatch(config, draft, "production")).toEqual({
      error: "profileMissing",
    });
  });

  it("builds add and delete payloads against the complete profile record", () => {
    const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
    const draft = {
      ...createCloudWorkerDraft(),
      id: "build-fleet",
      backend: "hetzner",
      machineClass: "standard",
    };
    const added = buildCloudWorkerUpsertPatch(config, draft, null);
    expect(added).toMatchObject({
      patch: {
        cloudWorkers: {
          profiles: {
            production: configuredProfile,
            "build-fleet": {
              provider: "crabbox",
              install: "bundle",
              settings: {
                provider: "hetzner",
                class: "standard",
                ttl: "8h",
                idleTimeout: "45m",
              },
            },
          },
        },
      },
    });
    expect(buildCloudWorkerDeletePatch(config, "production")).toEqual({
      patch: {
        cloudWorkers: {
          profiles: { production: null },
        },
      },
    });
  });

  it("removes only project defaults that reference a deleted profile", () => {
    const config = {
      cloudWorkers: {
        profiles: { production: configuredProfile, retained: configuredProfile },
        projectProfiles: {
          "github.com/acme/app": "production",
          "github.com/acme/docs": "production",
          "github.com/acme/retained": "retained",
        },
      },
    };

    expect(buildCloudWorkerDeletePatch(config, "production")).toEqual({
      patch: {
        cloudWorkers: {
          profiles: { production: null, retained: configuredProfile },
          projectProfiles: {
            "github.com/acme/app": null,
            "github.com/acme/docs": null,
          },
        },
      },
    });
  });
});
