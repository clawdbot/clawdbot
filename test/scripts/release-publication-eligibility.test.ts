import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  type ReleasePlanLock,
} from "../../scripts/release-plan-contract.mjs";
import type { VerifiedReleasePlanLock } from "../../scripts/release-plan-producer.mts";
import {
  parseReleasePublicationEligibilityReceiptJson,
  RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
  RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS,
  RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH,
  RELEASE_PUBLICATION_NPM_REGISTRY,
  type ReleasePublicationEligibilityReceipt,
} from "../../scripts/release-publication-eligibility-contract.mjs";
import {
  collectReleasePublicationEligibility,
  collectReleasePublicationObservations,
  publicNpmObservationCommand,
  retryNpmObservation,
  runReleasePublicationEligibilityCli,
} from "../../scripts/release-publication-eligibility.mts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const releasePlanLockFixture = JSON.parse(
  readFileSync(resolve("test/fixtures/release-plan-lock-v1.compatibility.json"), "utf8"),
) as ReleasePlanLock;

function verified(lock: ReleasePlanLock): VerifiedReleasePlanLock {
  return lock as VerifiedReleasePlanLock;
}

function provenance(lock: ReleasePlanLock) {
  return {
    repository: lock.plan.tooling.repository,
    workflow_path: RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH,
    workflow_ref: lock.plan.tooling.ref,
    workflow_sha: lock.plan.tooling.sha,
    run_id: "123456",
    run_attempt: 2,
    job: "publication-eligibility",
    artifact_id: "654321",
    artifact_digest: `sha256:${"d".repeat(64)}`,
  } as const;
}

function makeRepo() {
  const rootDir = tempDirs.make("openclaw-release-publication-eligibility-");
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  writeJsonFile(join(rootDir, "package.json"), {
    name: "openclaw",
    version: "2026.8.1-beta.2",
  });
  writePublishablePluginFixture(rootDir, {
    extensionId: "example",
    packageName: "@openclaw/example",
    version: "2026.8.1-beta.2",
    publishTo: "both",
    dependency: {
      packageName: "@openai/codex",
      version: "0.149.0",
      requireLatest: true,
    },
  });
  execFileSync("git", ["add", "."], { cwd: rootDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "candidate",
    ],
    { cwd: rootDir },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  const releasePlanLock = createReleasePlanLock({
    ...releasePlanLockFixture.plan,
    candidate_sha: candidateSha,
  });
  return {
    rootDir,
    releasePlanLock: verified(releasePlanLock),
  };
}

function readyClawHubFetch(): typeof fetch {
  return vi.fn(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(raw).pathname;
    if (pathname.endsWith("/trusted-publisher")) {
      return new Response(
        JSON.stringify({
          trustedPublisher: {
            provider: "github-actions",
            repository: "openclaw/openclaw",
            workflowFilename: "plugin-clawhub-release.yml",
          },
        }),
        { status: 200 },
      );
    }
    if (pathname.includes("/versions/")) {
      return new Response("", { status: 404 });
    }
    return new Response("{}", { status: 200 });
  });
}

describe("release publication eligibility collection", () => {
  it("collects exact ReleasePlan inventories into validation-only evidence", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    const latest = vi.fn(async () => "0.149.0");
    const npmPublished = vi.fn(async (name: string) => name === "openclaw");
    const fetchImpl = readyClawHubFetch();
    const receipt = await collectReleasePublicationEligibility({
      rootDir,
      receiptPath,
      releasePlanLock,
      provenance: provenance(releasePlanLock),
      fetchImpl,
      resolveLatestVersion: latest,
      resolveNpmPublishedVersion: npmPublished,
      now: () => Date.parse("2026-08-21T00:00:00.000Z"),
    });

    expect(latest).toHaveBeenCalledTimes(1);
    expect(npmPublished).toHaveBeenCalledTimes(2);
    expect(receipt).toMatchObject({
      evidence_scope: "validation-start-only",
      publication_authorized: false,
      observations: {
        latest_dependencies: [
          {
            name: "@openai/codex",
            required_version: "0.149.0",
            observed_version: "0.149.0",
          },
        ],
      },
    });
    expect(receipt.plans.npm).toEqual([
      { name: "@openclaw/example", version: "2026.8.1-beta.2", status: "vacant" },
      { name: "openclaw", version: "2026.8.1-beta.2", status: "already-published" },
    ]);
    expect(receipt.plans.clawhub).toEqual([
      { name: "@openclaw/example", version: "2026.8.1-beta.2", status: "vacant" },
    ]);
    expect(
      parseReleasePublicationEligibilityReceiptJson(readFileSync(receiptPath, "utf8")),
    ).toEqual(receipt);
    for (const [input] of vi.mocked(fetchImpl).mock.calls) {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(raw.startsWith(`${RELEASE_PUBLICATION_CLAWHUB_REGISTRY}/`)).toBe(true);
    }
  });

  it("reads candidate metadata from the exact commit, not the mutable checkout", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    writeJsonFile(join(rootDir, "package.json"), {
      name: "openclaw",
      version: "2099.1.1",
    });
    writeJsonFile(join(rootDir, "extensions/example/package.json"), {
      name: "@openclaw/mutated",
      version: "2099.1.1",
      private: true,
    });

    const receipt = await collectReleasePublicationEligibility({
      rootDir,
      receiptPath: join(rootDir, "receipt.json"),
      releasePlanLock,
      provenance: provenance(releasePlanLock),
      resolveLatestVersion: async () => "0.149.0",
      resolveNpmPublishedVersion: async () => false,
      resolveClawHubState: async () => ({
        packageExists: true,
        hasTrustedPublisher: true,
        alreadyPublished: false,
      }),
    });

    expect(receipt.plans.npm.map((entry) => entry.name)).toEqual(["@openclaw/example", "openclaw"]);
  });

  it("uses one fair global eight-slot pool and deduplicates latest reads", async () => {
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const run = async <T>(label: string, value: T) => {
      starts.push(label);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 5);
      });
      active -= 1;
      return value;
    };
    const clawHubPlugins = Array.from({ length: 6 }, (_, index) => ({
      extensionId: `plugin-${index}`,
      packageDir: `extensions/plugin-${index}`,
      packageName: `@openclaw/plugin-${index}`,
      version: "2026.8.1-beta.2",
      channel: "beta" as const,
      publishTag: "beta" as const,
    }));
    const latest = vi.fn(async (name: string) => await run(`latest:${name}`, "1.0.0"));
    const observations = await collectReleasePublicationObservations({
      requiredLatestDependencies: [
        { name: "dep-a", requiredVersion: "1.0.0" },
        { name: "dep-b", requiredVersion: "1.0.0" },
        { name: "dep-c", requiredVersion: "1.0.0" },
      ],
      npmPackages: Array.from({ length: 6 }, (_, index) => ({
        name: `@openclaw/npm-${index}`,
        version: "2026.8.1-beta.2",
      })),
      clawHubPlugins,
      resolveLatestVersion: latest,
      resolveNpmPublishedVersion: async (name) => await run(`npm:${name}`, false),
      resolveClawHubState: async (plugin) =>
        await run(`claw:${plugin.packageName}`, {
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
    });

    expect(latest).toHaveBeenCalledTimes(3);
    expect(observations.npm).toHaveLength(6);
    expect(observations.clawHub).toHaveLength(6);
    expect(maxActive).toBe(8);
    expect(starts.slice(0, 6)).toEqual([
      "latest:dep-a",
      "npm:@openclaw/npm-0",
      "claw:@openclaw/plugin-0",
      "latest:dep-b",
      "npm:@openclaw/npm-1",
      "claw:@openclaw/plugin-1",
    ]);
  });

  it("bounds each operation and reports failures in deterministic task order", async () => {
    await expect(
      collectReleasePublicationObservations({
        requiredLatestDependencies: [{ name: "dep-a", requiredVersion: "1.0.0" }],
        npmPackages: [],
        clawHubPlugins: [],
        resolveLatestVersion: async () =>
          await new Promise<string>(() => {
            // Deliberately unresolved to prove the operation cap.
          }),
        resolveNpmPublishedVersion: async () => false,
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
        operationTimeoutMs: 10,
      }),
    ).rejects.toThrow("exceeded 10ms operation cap");

    await expect(
      collectReleasePublicationObservations({
        requiredLatestDependencies: [
          { name: "dep-a", requiredVersion: "1.0.0" },
          { name: "dep-b", requiredVersion: "1.0.0" },
        ],
        npmPackages: [{ name: "openclaw", version: "2026.8.1-beta.2" }],
        clawHubPlugins: [],
        resolveLatestVersion: async (name) => {
          await new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, name === "dep-a" ? 10 : 1);
          });
          throw new Error(`failed ${name}`);
        },
        resolveNpmPublishedVersion: async () => {
          throw new Error("failed npm");
        },
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
      }),
    ).rejects.toThrow(
      /npm latest dep-a: failed dep-a[\s\S]+npm publication openclaw@2026\.8\.1-beta\.2: failed npm[\s\S]+npm latest dep-b: failed dep-b/u,
    );
  });

  it("aggregates stale dependency and ClawHub trust blockers", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    let message = "";
    try {
      await collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        provenance: provenance(releasePlanLock),
        resolveLatestVersion: async () => "0.150.0",
        resolveNpmPublishedVersion: async () => false,
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: false,
          alreadyPublished: false,
        }),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("must match npm latest for release");
    expect(message).toContain("GitHub Actions trusted publisher is missing");
    expect(() => readFileSync(receiptPath)).toThrow();
  });

  it("rejects missing candidate commits, invalid clocks, and elapsed freshness", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    const missingCandidate = verified(
      createReleasePlanLock({
        ...releasePlanLock.plan,
        candidate_sha: "c".repeat(40),
      }),
    );
    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock: missingCandidate,
        provenance: provenance(missingCandidate),
      }),
    ).rejects.toThrow("does not resolve");
    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        provenance: provenance(releasePlanLock),
        now: () => Number.NaN,
      }),
    ).rejects.toThrow("finite integer");
    const times = [0, RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS + 1];
    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        provenance: provenance(releasePlanLock),
        resolveLatestVersion: async () => "0.149.0",
        resolveNpmPublishedVersion: async () => false,
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
        now: () => times.shift() ?? RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS + 1,
      }),
    ).rejects.toThrow("exceeded five minutes");
  });

  it("forces public npm endpoints and strips all npm credential/config inheritance", async () => {
    const previous = {
      lower: process.env.npm_config_registry,
      token: process.env.NPM_TOKEN,
      userconfig: process.env.NPM_CONFIG_USERCONFIG,
      nodeToken: process.env.NODE_AUTH_TOKEN,
    };
    process.env.npm_config_registry = "https://npm.invalid";
    process.env.NPM_CONFIG_USERCONFIG = "/tmp/private-npmrc";
    process.env.NPM_TOKEN = "secret";
    process.env.NODE_AUTH_TOKEN = "secret";
    try {
      const command = publicNpmObservationCommand(
        ["openclaw", "version"],
        "/tmp/empty-user-npmrc",
        "/tmp/empty-global-npmrc",
        "/tmp/clean-cwd",
      );
      expect(command.args).toEqual(
        expect.arrayContaining([
          RELEASE_PUBLICATION_NPM_REGISTRY,
          "/tmp/empty-user-npmrc",
          "/tmp/empty-global-npmrc",
        ]),
      );
      expect(command.cwd).toBe("/tmp/clean-cwd");
      expect(command.env).not.toHaveProperty("npm_config_registry");
      expect(command.env).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
      expect(command.env).not.toHaveProperty("NPM_TOKEN");
      expect(command.env).not.toHaveProperty("NODE_AUTH_TOKEN");
      expect(command.env.HOME).toBe("/tmp/clean-cwd");
    } finally {
      for (const [name, value] of [
        ["npm_config_registry", previous.lower],
        ["NPM_CONFIG_USERCONFIG", previous.userconfig],
        ["NPM_TOKEN", previous.token],
        ["NODE_AUTH_TOKEN", previous.nodeToken],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }

    const sleep = vi.fn(async () => undefined);
    const succeeds = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValue("ok");
    await expect(retryNpmObservation(succeeds, sleep)).resolves.toBe("ok");
    expect(succeeds).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("wires the executable CLI through repository verification and receipt production", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const lockPath = join(rootDir, "release-plan-lock.json");
    const receiptPath = join(rootDir, "receipt.json");
    writeFileSync(lockPath, canonicalReleasePlanLockJson(releasePlanLock));
    const sentinel = { digest: "sentinel" } as ReleasePublicationEligibilityReceipt;
    const verifyLock = vi.fn(() => releasePlanLock);
    const collect = vi.fn(async () => sentinel);

    await expect(
      runReleasePublicationEligibilityCli(
        [
          "--release-plan-lock",
          lockPath,
          "--receipt",
          receiptPath,
          "--repo-root",
          rootDir,
          "--run-id",
          "123456",
          "--run-attempt",
          "2",
          "--job",
          "publication-eligibility",
          "--artifact-id",
          "654321",
          "--artifact-digest",
          `sha256:${"d".repeat(64)}`,
        ],
        { collect, verifyLock },
      ),
    ).resolves.toBe(sentinel);
    expect(verifyLock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        candidateSha: releasePlanLock.plan.candidate_sha,
        intent: "publish",
        repoRoot: rootDir,
        toolingSha: releasePlanLock.plan.tooling.sha,
      }),
    );
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        releasePlanLock,
        receiptPath,
        rootDir,
        provenance: provenance(releasePlanLock),
      }),
    );
  });

  it("runs as an executable CLI with the standard failure trailer", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/release-publication-eligibility.mts", "--wat"],
      {
        cwd: resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown release publication eligibility option: --wat");
    expect(result.stderr).toContain("[release-publication-eligibility] FAILED (exit 1)");
  });
});
