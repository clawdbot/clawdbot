import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { planLegacyStateMigrationsReadOnly } from "./state-migrations.doctor.js";

const tempDirs = createTrackedTempDirs();

async function makeFixture() {
  const root = await tempDirs.make("openclaw-migration-snapshot-identity-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  return { root, homeDir, stateDir, configPath, env };
}

async function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root: fixture.root, version: "test" },
    snapshot: {
      homeDir: fixture.homeDir,
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
    },
    env: fixture.env,
  });
}

afterEach(async () => {
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration snapshot identity", () => {
  it.each([
    "file-content",
    "file-replacement",
    "nested-entry",
    "unchanged",
    "config-content",
    "config-replacement",
    "included-config",
    "included-unchanged",
  ] as const)(
    "revalidates earlier entries after the final capture traversal: %s",
    async (mutation) => {
      const fixture = await makeFixture();
      const earlyDirectory = path.join(fixture.stateDir, "a-directory");
      const earlyFile = path.join(earlyDirectory, "probe.json");
      const lateFile = path.join(fixture.stateDir, "z-probe.json");
      fs.mkdirSync(earlyDirectory);
      fs.writeFileSync(earlyFile, '{"value":"original"}\n');
      fs.writeFileSync(lateFile, "{}\n");
      const includedPath = path.join(fixture.root, "planner-input.json");
      if (mutation === "included-config" || mutation === "included-unchanged") {
        fs.writeFileSync(fixture.configPath, '{"$include":"./planner-input.json"}\n');
        fs.writeFileSync(includedPath, "{}\n");
      }
      const realOpen = fs.promises.open.bind(fs.promises);
      let lateFileOpens = 0;
      let finalCaptureReached = false;
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (path.resolve(String(args[0])) === lateFile && ++lateFileOpens === 2) {
          finalCaptureReached = true;
          if (mutation === "file-content") {
            fs.writeFileSync(earlyFile, '{"value":"changed"}\n');
          } else if (mutation === "file-replacement") {
            fs.unlinkSync(earlyFile);
            fs.writeFileSync(earlyFile, '{"value":"replacement"}\n');
          } else if (mutation === "nested-entry") {
            fs.writeFileSync(path.join(earlyDirectory, "added.json"), "{}\n");
          } else if (mutation === "config-content" || mutation === "config-replacement") {
            if (mutation === "config-replacement") {
              fs.unlinkSync(fixture.configPath);
            }
            fs.writeFileSync(
              fixture.configPath,
              '{"agents":{"defaults":{"workspace":"./changed"}}}\n',
            );
          } else if (mutation === "included-config") {
            fs.writeFileSync(includedPath, '{"agents":{"defaults":{"workspace":"./changed"}}}\n');
          }
        }
        return handle;
      });

      const plan = await planFixture(fixture);

      expect(finalCaptureReached).toBe(true);
      expect(plan.refusal?.code).toBe(
        mutation === "unchanged" || mutation === "included-unchanged"
          ? "candidate-artifact-digest-required"
          : "snapshot-identity-unavailable",
      );
      if (mutation === "unchanged" || mutation === "included-unchanged") {
        expect(plan.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(fs.readFileSync(earlyFile, "utf8")).toBe('{"value":"original"}\n');
      }
    },
  );

  it("refuses an ordinary file replaced between tree inspection and open", async () => {
    const fixture = await makeFixture();
    const probePath = path.join(fixture.stateDir, "identity-probe.json");
    const originalPath = `${probePath}.original`;
    fs.writeFileSync(probePath, '{"value":"original"}\n');
    const realOpen = fs.promises.open.bind(fs.promises);
    let replacementTriggered = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (!replacementTriggered && path.resolve(String(args[0])) === probePath) {
        replacementTriggered = true;
        fs.renameSync(probePath, originalPath);
        fs.writeFileSync(probePath, '{"value":"replacement"}\n');
      }
      return realOpen(...args);
    });

    try {
      const plan = await planFixture(fixture);
      expect(replacementTriggered).toBe(true);
      expect(plan.snapshot.stateDigest).toBeUndefined();
      expect(plan.warnings).toEqual([
        expect.stringContaining(`Snapshot file changed while opening: ${probePath}`),
      ]);
    } finally {
      if (replacementTriggered) {
        fs.unlinkSync(probePath);
        fs.renameSync(originalPath, probePath);
      }
    }
  });

  it("binds in-snapshot hard-link topology", async () => {
    const fixture = await makeFixture();
    const firstPath = path.join(fixture.stateDir, "first.json");
    const secondPath = path.join(fixture.stateDir, "second.json");
    fs.writeFileSync(firstPath, '{"value":"same"}\n');
    fs.writeFileSync(secondPath, '{"value":"same"}\n');
    const independent = await planFixture(fixture);

    fs.unlinkSync(secondPath);
    fs.linkSync(firstPath, secondPath);
    const linked = await planFixture(fixture);

    expect(independent.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(linked.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(linked.snapshot.stateDigest).not.toBe(independent.snapshot.stateDigest);
  });

  it("refuses a snapshot file with an unbound external hard link", async () => {
    const fixture = await makeFixture();
    const externalPath = path.join(fixture.root, "external.json");
    const linkedPath = path.join(fixture.stateDir, "linked.json");
    fs.writeFileSync(externalPath, '{"value":"shared"}\n');
    fs.linkSync(externalPath, linkedPath);

    const plan = await planFixture(fixture);

    expect(plan.snapshot.stateDigest).toBeUndefined();
    expect(plan.warnings).toEqual([
      expect.stringContaining(`Snapshot file has links outside copied state: ${linkedPath}`),
    ]);
  });
});
