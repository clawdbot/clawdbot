import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
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
  suspendAfter: "30m",
  settings: {
    provider: "aws",
    class: "beast",
    ttl: "24h",
    idleTimeout: "60m",
    setup: "install-node",
    setupEnv: ["QA_WORKER_FLAG"],
    desktop: true,
    binary: "/opt/crabbox",
    opaque: { nullable: null, flags: ["kept"] },
  },
};

function requirePatch(result: ReturnType<typeof buildCloudWorkerUpsertPatch>) {
  if ("error" in result) {
    throw new Error(`Unexpected profile patch error: ${result.error}`);
  }
  return result;
}

describe("cloud worker settings state", () => {
  it.each([undefined, ""])("requires an explicit class for an empty draft (%j)", (machineClass) => {
    const profile = readCloudWorkerProfiles({
      cloudWorkers: {
        profiles: {
          production: {
            ...configuredProfile,
            settings: { ...configuredProfile.settings, class: machineClass },
          },
        },
      },
    })[0];
    const draft = createCloudWorkerDraft(machineClass === undefined ? undefined : profile);
    expect(draft.machineClass).toBe("");
    expect(
      validateCloudWorkerDraft({ ...draft, id: "new-profile", backend: "hetzner" }, {}, null),
    ).toBe("machineClass");
  });

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
    const draft = {
      ...createCloudWorkerDraft(),
      id: "new-profile",
      backend: "hetzner",
      machineClass: "standard",
      ...patch,
    };
    expect(validateCloudWorkerDraft(draft, { production: configuredProfile }, null)).toBe(expected);
  });

  it("clears setup with exact array intent while preserving opaque fields", () => {
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
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            production: {
              provider: "crabbox",
              install: "npm",
              settings: {
                provider: "hetzner",
                class: "large",
                ttl: "8h",
                idleTimeout: "45m",
                setup: null,
                setupEnv: null,
                desktop: null,
                binary: null,
              },
            },
          },
        },
      },
      replacePaths: ["cloudWorkers.profiles.production.settings.setupEnv"],
    });
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        profiles: {
          production: {
            provider: "crabbox",
            install: "npm",
            suspendAfter: "30m",
            settings: {
              provider: "hetzner",
              class: "large",
              ttl: "8h",
              idleTimeout: "45m",
              opaque: configuredProfile.settings.opaque,
            },
          },
        },
      },
    });
  });

  it.each(["standard", "fast", "large", "beast", "custom", "batch/ARM64.v2", "x".repeat(128)])(
    "preserves class %s and hidden settings when backend and binary change",
    (machineClass) => {
      const profile = {
        ...configuredProfile,
        settings: { ...configuredProfile.settings, class: machineClass },
      };
      const config = { cloudWorkers: { profiles: { production: profile } } };
      const draft = {
        ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
        backend: "hetzner",
        binary: "/opt/crabbox-next",
      };
      const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
      expect(applyMergePatch(config, built.patch)).toEqual({
        cloudWorkers: {
          profiles: {
            production: {
              ...profile,
              settings: {
                ...profile.settings,
                provider: "hetzner",
                binary: "/opt/crabbox-next",
              },
            },
          },
        },
      });
      expect(built.replacePaths).toEqual([]);
    },
  );

  it.each([{ setupEnv: undefined }, { setupEnv: [] }])(
    "keeps empty setup environment unchanged ($setupEnv)",
    ({ setupEnv }) => {
      const { setupEnv: _setupEnv, ...settings } = configuredProfile.settings;
      const existingSettings = { ...settings, ...(setupEnv ? { setupEnv } : {}) };
      const profile = { ...configuredProfile, settings: existingSettings };
      const config = { cloudWorkers: { profiles: { production: profile } } };
      const draft = { ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]), setup: "" };
      const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
      const { setup: _setup, ...retainedSettings } = existingSettings;
      expect(applyMergePatch(config, built.patch)).toEqual({
        cloudWorkers: {
          profiles: { production: { ...profile, settings: retainedSettings } },
        },
      });
      expect(built.replacePaths).toEqual([]);
    },
  );

  it.each([
    {
      name: "changes provider",
      replacement: {
        provider: "static-ssh",
        settings: { host: "worker.example.test", user: "openclaw" },
      },
    },
    {
      name: "removes its class",
      replacement: {
        provider: "crabbox",
        settings: { provider: "hetzner", ttl: "8h", idleTimeout: "45m", warmImage: false },
      },
    },
  ])("rejects an edit after its authoritative profile $name", ({ replacement }) => {
    const config = { cloudWorkers: { profiles: { production: replacement } } };
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

  it("adds only the new profile without resending existing profiles", () => {
    const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
    const draft = {
      ...createCloudWorkerDraft(),
      id: "build-fleet",
      backend: "hetzner",
      machineClass: "standard",
    };
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, null));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            "build-fleet": {
              provider: "crabbox",
              install: "bundle",
              settings: {
                provider: "hetzner",
                class: "standard",
                ttl: "8h",
                idleTimeout: "45m",
                setup: null,
                desktop: null,
                binary: null,
              },
            },
          },
        },
      },
      replacePaths: [],
    });
    expect(applyMergePatch(config, built.patch)).toMatchObject(config);
  });

  it("deletes only the target and its project defaults with exact array intent", () => {
    const deleted = {
      ...configuredProfile,
      settings: { ...configuredProfile.settings, empty: [] },
    };
    const config = {
      cloudWorkers: {
        profiles: { production: deleted, retained: configuredProfile },
        projectProfiles: {
          "github.com/acme/app": "production",
          "github.com/acme/docs": "production",
          "github.com/acme/retained": "retained",
        },
      },
    };
    const built = requirePatch(buildCloudWorkerDeletePatch(config, "production"));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: { production: null },
          projectProfiles: {
            "github.com/acme/app": null,
            "github.com/acme/docs": null,
          },
        },
      },
      replacePaths: [
        "cloudWorkers.profiles.production.settings.setupEnv",
        "cloudWorkers.profiles.production.settings.opaque.flags",
        "cloudWorkers.profiles.production.settings.empty",
      ],
    });
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        profiles: { retained: configuredProfile },
        projectProfiles: { "github.com/acme/retained": "retained" },
      },
    });
  });
});
