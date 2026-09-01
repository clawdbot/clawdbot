// Codesign Mac App tests cover codesign mac app script behavior.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { link } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, type TestContext } from "vitest";
import {
  machoFixture,
  nativeObjectFixture,
  universalArchiveFixture,
  writeFat64Fixture,
} from "../helpers/mac-native.js";
import {
  installFakeCodesign,
  installTransientFakeCodesign,
  installElevationFakeCodesign,
  makeSigningFixture,
} from "../helpers/mac-signing.js";
import { cleanupTempDirs } from "../helpers/temp-dir.js";
import { createMacScriptTest, type MacScriptFixture } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();
const scriptPath = "scripts/codesign-mac-app.sh";
// Signing integration exercises the real Darwin mutation fence, not a sandbox mock.
const macIt = it.runIf(process.platform === "darwin");

async function runCodesignWithoutAllocation(
  mac: MacScriptFixture,
  expect: TestContext["expect"],
  args: string[],
  tempRoot: string,
  env: NodeJS.ProcessEnv = {},
) {
  const binDir = path.join(tempRoot, "bin");
  const allocation = path.join(tempRoot, "allocation-attempted");
  const allocator = path.join(binDir, "mktemp");
  mkdirSync(binDir);
  writeFileSync(
    allocator,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(allocation)}, 'called');\nprocess.exit(91);\n`,
  );
  chmodSync(allocator, 0o755);
  const result = await mac.run("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: tempRoot,
    },
  });
  expect(existsSync(allocation), result.stderr).toBe(false);
  return result;
}

describe("codesign-mac-app temp file hygiene", () => {
  it.concurrent("does not generate unused entitlement plist files", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const script = readFileSync(scriptPath, "utf8");

      expect(script).toContain('ENT_TMP_APP="$ENT_TMP_DIR/app.plist"');
      expect(script).not.toContain("ENT_TMP_BASE");
      expect(script).not.toContain("ENT_TMP_RUNTIME");
      expect(script).not.toContain("base.plist");
      expect(script).not.toContain("runtime.plist");
    }));

  it.concurrent("does not allocate entitlement temp files for help output", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-help-");
      const result = await runCodesignWithoutAllocation(mac, expect, ["--help"], tempRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: scripts/codesign-mac-app.sh");
    }));

  it.concurrent("does not allocate entitlement temp files before app validation", ({
    mac,
    expect,
  }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-missing-");
      const missingApp = path.join(tempRoot, "Missing.app");
      const result = await runCodesignWithoutAllocation(mac, expect, [missingApp], tempRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("App bundle not found");
    }));

  it.concurrent("rejects unknown options before app validation", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-unknown-");
      const result = await runCodesignWithoutAllocation(mac, expect, ["--wat"], tempRoot);

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("ERROR: Unknown codesign option: --wat");
    }));

  it.concurrent("rejects extra app bundle arguments before signing", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-extra-");
      const app = path.join(tempRoot, "Fake.app");
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
      const result = await runCodesignWithoutAllocation(mac, expect, [app, "extra"], tempRoot);

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("ERROR: Unexpected codesign argument: extra");
    }));

  macIt.concurrent("keeps helper signing plain and seals app code once", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-success-");
      const app = path.join(tempRoot, "Fake.app");
      const binDir = path.join(tempRoot, "bin");
      const captureDir = path.join(app, "Contents", "test-capture");
      const logPath = path.join(captureDir, "codesign.log");
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
      mkdirSync(binDir);
      mkdirSync(captureDir);
      writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
      writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
      installFakeCodesign(binDir);

      const result = await mac.run("bash", [scriptPath, app], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CODESIGN_CAPTURE_DIR: captureDir,
          CODESIGN_LOG: logPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          SIGN_IDENTITY: "-",
          SKIP_TEAM_ID_CHECK: "1",
          TMPDIR: tempRoot,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Codesign complete for ${app}`);

      const signLines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(signLines).toHaveLength(2);
      expect(signLines[0]).toBe(
        `plain\t${path.join(app, "Contents", "MacOS", "openclaw-mlx-tts")}`,
      );
      expect(signLines[1]).toContain(`entitled\t${app}\t`);
      for (const line of signLines.slice(1)) {
        const columns = line.split("\t");
        const entitlementPath = columns[2];
        const copiedEntitlementsPath = columns[3];
        const entitlementSource = expectDefined(
          entitlementPath,
          "codesign entitlement source path",
        );
        const copiedEntitlementSource = expectDefined(
          copiedEntitlementsPath,
          "copied codesign entitlement path",
        );
        const copiedEntitlements = readFileSync(copiedEntitlementSource, "utf8");
        expect(entitlementSource).toContain("openclaw-entitlements");
        expect(existsSync(entitlementSource)).toBe(false);
        expect(existsSync(path.dirname(entitlementSource))).toBe(false);
        expect(copiedEntitlements).toContain("com.apple.security.automation.apple-events");
        expect(copiedEntitlements).toContain("com.apple.security.device.camera");
      }
    }),
  );

  it.concurrent.for([
    ["DISABLE_LIBRARY_VALIDATION", "forbids DISABLE_LIBRARY_VALIDATION=1"],
    ["SKIP_TEAM_ID_CHECK", "forbids SKIP_TEAM_ID_CHECK=1"],
  ] as const)(
    "rejects elevation-host %s bypasses before app validation",
    ([key, diagnostic], { mac, expect }) =>
      mac.lifetime.run(async () => {
        const tempRoot = mac.createTempDir("openclaw-codesign-elevation-bypass-");
        const result = await runCodesignWithoutAllocation(
          mac,
          expect,
          [path.join(tempRoot, "Missing.app")],
          tempRoot,
          {
            OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
            [key]: "1",
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(diagnostic);
      }),
  );

  it.concurrent("defines a closed Foundation elevation-host signing profile", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const script = readFileSync(scriptPath, "utf8");
      const elevationProfile = script.slice(
        script.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]'),
        script.indexOf("else", script.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]')),
      );

      expect(script).toContain(
        'ELEVATION_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"',
      );
      expect(script).toContain('ELEVATION_TEAM_ID="FWJYW4S8P8"');
      expect(elevationProfile).toContain("<dict/>");
      expect(elevationProfile).not.toContain("com.apple.security.automation.apple-events");
      expect(script).toContain("verify_elevation_signature");
      expect(script).toContain('assert_no_apple_events_entitlement "$APP_BUNDLE"');
    }));

  it.concurrent.for(["file", "symlink"])(
    "rejects an elevation-host CUA driver %s before signing",
    (kind, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const tempRoot = mac.createTempDir(`openclaw-codesign-elevation-cua-${kind}-`);
        const app = path.join(tempRoot, "Fake.app");
        const binDir = path.join(tempRoot, "bin");
        const resources = path.join(app, "Contents", "Resources");
        mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(resources, { recursive: true });
        mkdirSync(binDir);
        writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
        const cuaDriver = path.join(resources, "cua-driver");
        if (kind === "file") {
          writeFileSync(cuaDriver, "driver\n");
        } else {
          symlinkSync("/missing/cua-driver", cuaDriver);
        }
        installElevationFakeCodesign(binDir);

        const result = await mac.run("bash", [scriptPath, app], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
            TMPDIR: tempRoot,
          },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("must not contain bundled CUA driver");
      }),
  );

  macIt.concurrent(
    "consumes complete codesign metadata under pipefail before validating authority",
    ({ mac, expect }) =>
      mac.lifetime.run(async () => {
        const tempRoot = mac.createTempDir("openclaw-codesign-elevation-metadata-");
        const app = path.join(tempRoot, "Fake.app");
        const binDir = path.join(tempRoot, "bin");
        mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(binDir);
        writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
        installElevationFakeCodesign(binDir);

        const result = await mac.run("bash", [scriptPath, app], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CODESIGN_FAKE_SECOND_AUTHORITY: "1",
            OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
            TMPDIR: tempRoot,
          },
        });

        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).toContain(`Codesign complete for ${app}`);
        expect(result.stderr).not.toContain("Elevation host requires");
      }),
  );

  macIt.concurrent(
    "preserves the precise diagnostic when codesign omits Authority",
    ({ mac, expect }) =>
      mac.lifetime.run(async () => {
        const tempRoot = mac.createTempDir("openclaw-codesign-elevation-no-authority-");
        const app = path.join(tempRoot, "Fake.app");
        const binDir = path.join(tempRoot, "bin");
        mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(binDir);
        writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
        installElevationFakeCodesign(binDir);

        const result = await mac.run("bash", [scriptPath, app], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CODESIGN_FAKE_NO_AUTHORITY: "1",
            OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
            TMPDIR: tempRoot,
          },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("got 'not set'");
      }),
  );

  macIt.concurrent("preserves a codesign failure after metadata output", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-elevation-failed-metadata-");
      const app = path.join(tempRoot, "Fake.app");
      const binDir = path.join(tempRoot, "bin");
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
      mkdirSync(binDir);
      writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
      installElevationFakeCodesign(binDir);

      const result = await mac.run("bash", [scriptPath, app], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CODESIGN_FAKE_FAIL_AFTER_METADATA: "1",
          OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
          TMPDIR: tempRoot,
        },
      });

      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.stdout).not.toContain(`Codesign complete for ${app}`);
      expect(result.stderr).toContain("Could not read codesign metadata");
    }),
  );

  macIt.concurrent("retries only transient Apple timestamp failures", ({ mac, expect }) =>
    mac.lifetime.run(async () => {
      const tempRoot = mac.createTempDir("openclaw-codesign-retry-");
      const app = path.join(tempRoot, "Fake.app");
      const binDir = path.join(tempRoot, "bin");
      const countFile = path.join(app, "Contents", "codesign-count");
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
      mkdirSync(binDir);
      writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
      writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
      installTransientFakeCodesign(binDir);

      const result = await mac.run("bash", [scriptPath, app], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CODESIGN_COUNT_FILE: countFile,
          CODESIGN_TIMESTAMP_RETRY_ATTEMPTS: "3",
          CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS: "0",
          CODESIGN_TRANSIENT_FAILURES: "2",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
          SKIP_TEAM_ID_CHECK: "1",
          TMPDIR: tempRoot,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Transient Apple timestamp failure");
      expect(readFileSync(countFile, "utf8")).toBe("4");
    }),
  );

  macIt.concurrent.for(["helper", "app bundle"])(
    "cleans signing resources without retrying non-timestamp %s failures",
    (target, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const tempRoot = mac.createTempDir("openclaw-codesign-permanent-");
        const app = path.join(tempRoot, "Fake.app");
        const binDir = path.join(tempRoot, "bin");
        const countFile = path.join(app, "Contents", "codesign-count");
        mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(binDir);
        if (target === "helper") {
          writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
        }
        installTransientFakeCodesign(binDir);
        // Keep identity lookup and attribute cleanup inert even if signing setup changes.
        for (const command of ["security", "xattr"]) {
          writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        }

        const result = await mac.run("bash", [scriptPath, app], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            CODESIGN_COUNT_FILE: countFile,
            CODESIGN_PERMANENT_FAILURE: "1",
            CODESIGN_TIMESTAMP_RETRY_ATTEMPTS: "3",
            CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS: "0",
            CODESIGN_TRANSIENT_FAILURES: "0",
            PATH: `${binDir}:/usr/bin:/bin`,
            SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
            SKIP_TEAM_ID_CHECK: "1",
            TMPDIR: tempRoot,
          },
        });

        // Darwin mktemp -t can ignore TMPDIR; observe the actual signer allocation.
        const directory = readFileSync(`${countFile}.tempdir`, "utf8");
        try {
          expect(result.status, result.stderr).toBe(7);
          expect(result.stdout).not.toContain("Codesign complete");
          expect(result.stderr).not.toContain("Transient Apple timestamp failure");
          expect(readFileSync(countFile, "utf8")).toBe("1");
          expect(existsSync(directory)).toBe(false);
          if (target === "app bundle") {
            const entitlementPath = readFileSync(`${countFile}.entitlements`, "utf8");
            expect(path.dirname(entitlementPath)).toBe(directory);
            expect(existsSync(entitlementPath)).toBe(false);
          } else {
            expect(existsSync(`${countFile}.entitlements`)).toBe(false);
          }
        } finally {
          // Clean a regression's task-created leak, never an unexpected system path.
          if (path.basename(directory).startsWith("openclaw-entitlements.")) {
            cleanupTempDirs([directory]);
          }
        }
      }),
  );

  macIt.concurrent.for([
    {
      label: "Developer ID hash",
      identity: "63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1",
      timestamp: true,
    },
    {
      label: "lowercase Developer ID hash",
      identity: "63a99bff1d40e5a75c8a32b84be99d1dda6a44e1",
      timestamp: true,
    },
    {
      label: "Developer ID name",
      identity: "Developer ID Application: Example Corp (ABCDE12345)",
      timestamp: true,
    },
    {
      label: "development certificate hash",
      identity: "11AA22BB33CC44DD55EE66FF77008899AABBCCDD",
      timestamp: false,
    },
    {
      label: "unknown certificate hash",
      identity: "0123456789ABCDEF0123456789ABCDEF01234567",
      timestamp: false,
    },
    { label: "ad-hoc identity", identity: "-", timestamp: false },
    {
      label: "explicitly disabled timestamp",
      identity: "63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1",
      timestamp: false,
      mode: "off",
    },
  ])(
    "applies automatic timestamp policy to $label",
    ({ identity, timestamp, mode }, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const tempRoot = mac.createTempDir("openclaw-codesign-timestamp-");
        const app = path.join(tempRoot, "Fake.app");
        const binDir = path.join(tempRoot, "bin");
        const captureDir = path.join(app, "Contents", "test-capture");
        const argsLog = path.join(captureDir, "codesign-args.log");
        mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(binDir);
        mkdirSync(captureDir);
        writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
        installFakeCodesign(binDir);
        const fakeSecurity = path.join(binDir, "security");
        writeFileSync(
          fakeSecurity,
          `#!/usr/bin/env bash
printf '%s\\n' \\
  '  1) 63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1 "Developer ID Application: Example Corp (ABCDE12345)"' \\
  '  2) 11AA22BB33CC44DD55EE66FF77008899AABBCCDD "Apple Development: Example Developer (ABCDE12345)"'
`,
        );
        chmodSync(fakeSecurity, 0o755);

        const result = await mac.run("bash", [scriptPath, app], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CODESIGN_ARGS_LOG: argsLog,
            CODESIGN_CAPTURE_DIR: captureDir,
            CODESIGN_LOG: path.join(captureDir, "codesign.log"),
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            SIGN_IDENTITY: identity,
            SKIP_TEAM_ID_CHECK: "1",
            TMPDIR: tempRoot,
            ...(mode === undefined ? {} : { CODESIGN_TIMESTAMP: mode }),
          },
        });

        expect(result.status).toBe(0);
        const expectedFlag = timestamp ? "--timestamp" : "--timestamp=none";
        for (const args of readFileSync(argsLog, "utf8").trim().split("\n")) {
          expect(args.split(" ")).toContain(expectedFlag);
        }
      }),
  );
});

describe.runIf(process.platform === "darwin")("Mac native inventory", () => {
  const workerPath = "Contents/Resources/node-worker/arm64/";

  it.concurrent.for([
    { arch: "arm64", sdkArch: "arm64", cpuType: 0x0100000c },
    { arch: "x86_64", sdkArch: "x64", cpuType: 0x01000007 },
  ])(
    "limits worker JIT entitlements to known JS runtime executables on $arch",
    ({ arch, sdkArch, cpuType }, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-jit-"));
        const modules = "lib/node_modules/openclaw/node_modules";
        const sdkRuntime = `node_modules/@anthropic-ai/claude-agent-sdk-darwin-${sdkArch}/claude`;
        const expected = new Map<string, boolean>();
        for (const [relative, fileType, jit] of [
          ["bin/node", 2, true],
          [`lib/node_modules/openclaw/${sdkRuntime}`, 2, true],
          [`${modules}/nested/${sdkRuntime}`, 2, true],
          [
            `${modules}/@lydell/node-pty-darwin-${sdkArch}/prebuilds/darwin-${sdkArch}/spawn-helper`,
            2,
            false,
          ],
          [`${modules}/other/bin/node`, 2, false],
          [`${modules}/other/claude`, 2, false],
          [`${modules}/library/${sdkRuntime}`, 6, false],
          ["lib/addon.node", 6, false],
        ] as const) {
          const bytes = machoFixture(64, true, false, fileType);
          bytes.writeUInt32LE(cpuType, 4);
          const filename = fixture.put(`Contents/Resources/node-worker/${arch}/${relative}`, bytes);
          expected.set(filename, jit);
        }
        const result = await fixture.run();
        expect(result.status, result.stderr).toBe(0);
        const events = fixture.events();
        const signs = events.filter(({ args }) => args.includes("--sign"));
        expect(signs).toHaveLength(expected.size + 1);
        expect(signs.at(-1)?.args.at(-1)).toBe(fixture.app);
        for (const [filename, jit] of expected) {
          const signed = expectDefined(
            signs.find(({ args }) => args.at(-1) === filename),
            filename,
          );
          const keys = Array.from(
            signed.entitlements.matchAll(/<key>([^<]+)<\/key>/g),
            (match) => match[1],
          );
          expect(keys, filename).toEqual(
            jit
              ? [
                  "com.apple.security.cs.allow-jit",
                  "com.apple.security.cs.allow-unsigned-executable-memory",
                ]
              : [],
          );
          expect(signed.args).toEqual(
            expect.arrayContaining(["--force", "--options", "runtime", "--timestamp", "--sign"]),
          );
          expect(signed.args.includes("--entitlements"), filename).toBe(jit);
          expect(
            events.some(
              ({ args }) =>
                args.at(-1) === filename && args.includes("--verify") && args.includes("--strict"),
            ),
          ).toBe(true);
        }
      }),
  );

  it.concurrent.for([false, true])(
    "selects every canonical native format with header-appropriate entitlements (elevation: %s)",
    (elevation, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-formats-"));
        const expected = new Map<string, boolean>();
        const candidates: string[] = [];
        for (const bits of [32, 64]) {
          for (const little of [false, true]) {
            for (const fat of [false, true]) {
              // mach-o/fat.h requires big-endian containers; swapped wrappers are rejected below.
              if (fat && little) {
                continue;
              }
              for (const type of [2, 6]) {
                const filename = fixture.put(
                  `${workerPath}formats/${bits}-${little}-${fat}-${type} executable\n\t'\\/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
                  machoFixture(bits, little, fat, type),
                );
                candidates.push(filename);
                expected.set(filename, type === 2);
              }
            }
          }
        }
        for (const [name, bytes] of [
          ["Mach-O executable.txt", Buffer.from("not native code")],
          ["Java.class", Buffer.from("cafebabe0000003d0001", "hex")],
          ["truncated", Buffer.from("cffa", "hex")],
          ["fat-false-positive", Buffer.from("cafebabe", "hex")],
        ] as const) {
          fixture.put(workerPath + name, bytes);
        }
        symlinkSync(
          expectDefined(candidates[0], "native fixture"),
          path.join(fixture.worker, "native-link"),
        );
        symlinkSync("missing", path.join(fixture.worker, "dangling"));
        const result = await fixture.run({}, elevation);
        expect(result.status, result.stderr).toBe(0);
        const events = fixture.events();
        const signed = events.filter(
          ({ args }) => args.includes("--sign") && args.at(-1) !== fixture.app,
        );
        expect(signed).toHaveLength(expected.size);
        expect(new Set(signed.map(({ args }) => args.at(-1)))).toEqual(new Set(expected.keys()));
        for (const { args, entitlements } of signed) {
          const target = expectDefined(args.at(-1), "signed path");
          expect(entitlements.includes("allow-jit"), target).toBe(expected.get(target));
          expect(entitlements).not.toContain("disable-library-validation");
          expect(entitlements).not.toContain("automation.apple-events");
          expect(
            events.some(
              ({ args: verify }) =>
                verify.includes("--verify") &&
                verify.includes("--strict") &&
                verify.at(-1) === target,
            ),
          ).toBe(true);
        }
        for (const { args } of events.filter(
          ({ args: query }) => query.includes("-dv") || query.includes("-d"),
        )) {
          expect(new Set([fixture.app, ...expected.keys()])).toContain(args.at(-1));
        }
        const classifiedMagics = new Set(fixture.classifications().flatMap(({ magics }) => magics));
        expect(classifiedMagics).toEqual(
          new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "cafebabf"]),
        );
      }),
  );

  it.concurrent.for([32, 64])(
    "examines but rejects byte-swapped fat%d containers",
    (bits, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(
          mac,
          mac.createTempDir("openclaw-inventory-swapped-fat-"),
        );
        const bytes = machoFixture(bits, true, true);
        fixture.put(workerPath + "invalid-fat.node", bytes);
        const result = await fixture.run();
        expect(result.status, result.stdout).not.toBe(0);
        expect(result.stderr).toMatch(/native header/i);
        expect(fixture.classifications().flatMap(({ magics }) => magics)).toContain(
          bytes.subarray(0, 4).toString("hex"),
        );
        expect(fixture.events()).toEqual([]);
      }),
  );

  it.concurrent.for([false, true])(
    "classifies real fat64 code and rejects mixed slice types (mixed: %s)",
    (mixed, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(
          mac,
          mac.createTempDir("openclaw-inventory-real-fat64-"),
        );
        const native = fixture.put(workerPath + "bin/node");
        const bytes = writeFat64Fixture(native);
        expect(bytes.readUInt32BE(0)).toBe(0xcafebabf);
        expect(bytes.readUInt32BE(4)).toBeGreaterThanOrEqual(2);
        if (mixed) {
          const offset = Number(bytes.readBigUInt64BE(48));
          expect(bytes.readUInt32LE(offset)).toBe(0xfeedfacf);
          bytes.writeUInt32LE(6, offset + 12); // One MH_DYLIB slice must not inherit MH_EXECUTE JIT rights.
          writeFileSync(native, bytes);
        }
        expect((await mac.run("/usr/bin/lipo", ["-archs", native])).status).toBe(0);
        const result = await fixture.run();
        if (mixed) {
          expect(result.status, result.stdout).not.toBe(0);
          expect(result.stderr).toMatch(/mixed.*native/i);
          expect(fixture.events()).toEqual([]);
          return;
        }
        expect(result.status, result.stderr).toBe(0);
        const signs = fixture
          .events()
          .filter(({ args }) => args.includes("--sign") && args.at(-1) === native);
        expect(signs).toHaveLength(1);
        expect(signs[0]?.entitlements).toContain("allow-jit");
      }),
  );

  it.concurrent("separates documented Mach-O resources from native signing candidates", ({
    mac,
    expect,
  }) =>
    mac.lifetime.run(async () => {
      const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-macho-filetypes-"));
      const resources = new Map<string, Buffer>();
      const candidates: string[] = [];
      for (const fileType of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11]) {
        const bytes = machoFixture(64, true, false, fileType);
        const filename = fixture.put(
          `${workerPath}type-${fileType}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
          bytes,
        );
        if ([1, 4, 9, 10].includes(fileType)) {
          resources.set(filename, bytes);
        } else {
          candidates.push(filename);
        }
      }
      const result = await fixture.run();
      expect(result.status, result.stderr).toBe(0);
      const events = fixture.events();
      const signed = events
        .filter(({ args }) => args.includes("--sign"))
        .map(({ args }) => args.at(-1));
      expect(signed).toHaveLength(candidates.length + 1);
      expect(new Set(signed)).toEqual(new Set([...candidates, fixture.app]));
      for (const [filename, bytes] of resources) {
        expect(readFileSync(filename)).toEqual(bytes);
        expect(events.filter(({ args }) => args.at(-1) === filename)).toEqual([]);
      }
    }));

  it.concurrent.for(["thin", "fat32", "fat64"] as const)(
    "resource-seals real %s linker objects without direct signing",
    (format, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-real-object-");
        const fixture = makeSigningFixture(mac, root);
        const node = fixture.put(workerPath + "bin/node");
        const bytes = nativeObjectFixture(path.join(root, "object-inputs"), format);
        const object = fixture.put(workerPath + "opaque-object", bytes);
        const result = await fixture.run();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(object)).toEqual(bytes);
        const events = fixture.events();
        expect(events.filter(({ args }) => args.at(-1) === object)).toEqual([]);
        expect(
          events.filter(({ args }) => args.includes("--sign")).map(({ args }) => args.at(-1)),
        ).toEqual([node, fixture.app]);
      }),
  );

  it.concurrent.for(
    [false, true].flatMap((fat64) => [0, 1].map((imageSlice) => ({ fat64, imageSlice }))),
  )(
    "rejects object/image containers in either slice order (fat64: $fat64, image: $imageSlice)",
    ({ fat64, imageSlice }, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-mixed-object-");
        const fixture = makeSigningFixture(mac, root);
        const bytes = nativeObjectFixture(
          path.join(root, "object-inputs"),
          fat64 ? "fat64" : "fat32",
        );
        const record = 8 + imageSlice * (fat64 ? 32 : 20);
        const offset = fat64
          ? Number(bytes.readBigUInt64BE(record + 8))
          : bytes.readUInt32BE(record + 8);
        expect(bytes.readUInt32LE(offset)).toBe(0xfeedfacf);
        bytes.writeUInt32LE(6, offset + 12);
        fixture.put(workerPath + "mixed", bytes);
        const result = await fixture.run();
        expect(result.status, result.stdout).not.toBe(0);
        expect(result.stderr).toMatch(/Mixed.*resource/);
        expect(fixture.events()).toEqual([]);
      }),
  );

  it.concurrent.for(
    [false, true].flatMap((fat64) =>
      ["archive", "mixed", "invalid"].map((content) => ({ fat64, content })),
    ),
  )(
    "resource-seals static archives and rejects mixed images (fat64: $fat64, $content)",
    ({ fat64, content }, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-inventory-archive-");
        const fixture = makeSigningFixture(mac, root);
        const node = fixture.put(workerPath + "node");
        const bytes = universalArchiveFixture(
          path.join(root, "archive-inputs"),
          fat64,
          content !== "archive",
        );
        if (content === "invalid") {
          for (let index = 0; index < bytes.readUInt32BE(4); index++) {
            const record = 8 + index * (fat64 ? 32 : 20);
            const offset = fat64
              ? Number(bytes.readBigUInt64BE(record + 8))
              : bytes.readUInt32BE(record + 8);
            if (bytes.readUInt32LE(offset) === 0xfeedfacf) {
              bytes.writeUInt32LE(0, offset);
            }
          }
        }
        const archive = fixture.put(workerPath + "opaque-resource", bytes);
        const result = await fixture.run();
        expect(readFileSync(archive)).toEqual(bytes);
        if (content !== "archive") {
          expect(result.status, result.stdout).not.toBe(0);
          expect(result.stderr).toMatch(
            content === "mixed" ? /Mixed.*resource/i : /Unrecognized native header/,
          );
          expect(fixture.events()).toEqual([]);
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(
            fixture
              .events()
              .filter(({ args }) => args.includes("--sign"))
              .map(({ args }) => args.at(-1)),
          ).toEqual([node, fixture.app]);
        }
      }),
  );

  it.concurrent("keeps classification process count bounded at candidate scale and never follows symlinks", ({
    mac,
    expect,
  }) =>
    mac.lifetime.run(async () => {
      const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-scale-"));
      for (let i = 0; i < 24; i++) {
        fixture.put(`${workerPath}native-${i}`, machoFixture(64, true, false, i % 2 ? 6 : 2));
      }
      const dataSource = path.join(path.dirname(fixture.app), "non-code-payload");
      writeFileSync(dataSource, "export {};\n");
      for (let start = 24; start < 1_024; start += 256) {
        const directory = path.join(fixture.worker, "data", String(start));
        mkdirSync(directory, { recursive: true });
        await Promise.all(
          Array.from({ length: Math.min(256, 1_024 - start) }, (_, index) =>
            link(dataSource, path.join(directory, `${start + index}.js`)),
          ),
        );
      }
      const outside = path.join(path.dirname(fixture.app), "external");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "native"), machoFixture());
      symlinkSync(outside, path.join(fixture.worker, "directory-link"));
      symlinkSync(path.join(outside, "native"), path.join(fixture.worker, "file-link"));
      symlinkSync("missing", path.join(fixture.worker, "dangling"));
      const result = await fixture.scan({ maxFileCalls: 8 });
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.classifications().length).toBeLessThanOrEqual(2);
      const records = result.stdout.split("\0");
      expect(records.pop()).toBe("");
      const natives = records.filter((kind, index) => index % 2 === 0 && kind !== "symlink");
      expect(natives).toHaveLength(24);
      expect(records.filter((kind, index) => index % 2 === 0 && kind === "symlink")).toHaveLength(
        3,
      );
      expect(records).not.toContain(path.join(outside, "native"));
    }));

  it.concurrent.for(["", "/", "///"])(
    "rejects a symlink bundle root with suffix %j before signing",
    (suffix, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-inventory-root-link-");
        const fixture = makeSigningFixture(mac, root);
        fixture.put(workerPath + "node");
        const alias = path.join(root, "Alias.app");
        symlinkSync(fixture.app, alias);
        const result = await fixture.run({}, false, alias + suffix);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("must not be a symlink");
        expect(fixture.events()).toEqual([]);
      }),
  );

  it.concurrent.for([
    "before-directory-open",
    "after-directory-open",
    "before-classification",
    "after-classification",
    "before-sign",
  ])("rejects directory swaps without mutating external files (%s)", (swapStage, { mac, expect }) =>
    mac.lifetime.run(async () => {
      const root = mac.createTempDir("openclaw-inventory-swap-");
      const fixture = makeSigningFixture(mac, root);
      const swapDirectory = path.join(fixture.worker, "package");
      const externalDirectory = path.join(root, "external");
      const name = "native ' payload\n.node";
      const external = path.join(externalDirectory, name);
      mkdirSync(swapDirectory);
      mkdirSync(externalDirectory);
      const original = machoFixture();
      writeFileSync(external, original);
      const attribute = "org.openclaw.signing-fixture";
      expect(
        (await mac.run("/usr/bin/xattr", ["-w", attribute, "untouched", external])).status,
      ).toBe(0);
      // The first schedule discovers a file that never existed in the bundle.
      // Later schedules redirect a previously discovered name at the next boundary.
      if (swapStage !== "before-directory-open") {
        fixture.put(`${workerPath}package/${name}`);
      }
      const result = await fixture.run({
        swapStage,
        swapDirectory,
        externalDirectory,
        retainedDirectory: path.join(root, "retained-package"),
        swapTarget: path.join(swapDirectory, name),
      });
      expect(fixture.swaps(), result.stderr).toEqual([{ stage: swapStage }]);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect.soft(readFileSync(external)).toEqual(original);
      expect
        .soft(
          (await mac.run("/usr/bin/xattr", ["-p", attribute, external], { encoding: "utf8" }))
            .stdout,
        )
        .toBe("untouched\n");
      expect.soft(result.status, result.stdout + result.stderr).not.toBe(0);
      expect.soft(result.stdout).not.toContain("Codesign complete");
      const signs = fixture.events().filter(({ args }) => args.includes("--sign"));
      if (swapStage === "before-sign") {
        expect(signs).toEqual([
          expect.objectContaining({ resolvedTarget: external, mutationAttempt: true }),
        ]);
        expect(result.stderr).toMatch(/signing write rejected: (EPERM|EACCES)/);
      } else {
        expect(signs).toEqual([]);
      }
    }),
  );

  it.concurrent("allows bundle writes but closes inherited writable descriptors", ({
    mac,
    expect,
  }) =>
    mac.lifetime.run(async () => {
      const root = mac.createTempDir("openclaw-inventory-descriptors-");
      const fixture = makeSigningFixture(mac, root);
      const native = fixture.put(workerPath + "node");
      const signed = await fixture.run({ writeTarget: native });
      expect(signed.status, signed.stderr).toBe(0);
      expect(readFileSync(native).subarray(-19).toString()).toBe("\nfixture-signature\n");

      const external = path.join(root, "external");
      writeFileSync(external, "untouched");
      const scratch = path.join(root, "mutation-tmp");
      mkdirSync(scratch);
      const result = await mac.run(
        "/usr/bin/python3",
        [
          "-c",
          `
import os, subprocess, sys
with open(sys.argv[1], 'ab', buffering=0) as stream:
    fd = stream.fileno()
    result = subprocess.run([
        '/usr/bin/python3', 'scripts/lib/mac-bundle-mutation.py', sys.argv[2], sys.argv[3],
        '/usr/bin/python3', '-c', 'import os,sys; os.write(int(sys.argv[1]), b"changed")', str(fd)
    ], pass_fds=(fd,))
    sys.exit(result.returncode)
`,
          external,
          fixture.app,
          scratch,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Bad file descriptor");
      expect(readFileSync(external, "utf8")).toBe("untouched");
    }));

  it.concurrent("rejects hardlinked input before clearing an external alias's attributes", ({
    mac,
    expect,
  }) =>
    mac.lifetime.run(async () => {
      const root = mac.createTempDir("openclaw-inventory-hardlink-");
      const fixture = makeSigningFixture(mac, root);
      const external = path.join(root, "external");
      writeFileSync(external, machoFixture());
      const attribute = "org.openclaw.signing-fixture";
      expect(
        (await mac.run("/usr/bin/xattr", ["-w", attribute, "untouched", external])).status,
      ).toBe(0);
      await link(external, path.join(fixture.worker, "native.node"));
      const result = await fixture.run();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("private app copy");
      expect(fixture.events()).toEqual([]);
      expect(
        (await mac.run("/usr/bin/xattr", ["-p", attribute, external], { encoding: "utf8" })).stdout,
      ).toBe("untouched\n");
    }));

  it.concurrent("rejects special files before attribute cleanup can block on them", ({
    mac,
    expect,
  }) =>
    mac.lifetime.run(async () => {
      const root = mac.createTempDir("openclaw-inventory-fifo-");
      const fixture = makeSigningFixture(mac, root);
      expect((await mac.run("/usr/bin/mkfifo", [path.join(fixture.worker, "fifo")])).status).toBe(
        0,
      );
      // Observe the cleanup boundary without letting a regression hang real xattr on the FIFO.
      const invoked = path.join(fixture.app, "xattr-invoked");
      const xattr = path.join(root, "bin", "xattr");
      writeFileSync(
        xattr,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'called');\n`,
      );
      chmodSync(xattr, 0o755);
      const result = await fixture.run();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("special files");
      expect(existsSync(invoked)).toBe(false);
      expect(fixture.events()).toEqual([]);
    }));

  it.concurrent.for(["", "/", "///"])(
    "seals each bundle owner once after nested code with suffix %j",
    (suffix, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-order-"));
        const helper = fixture.put("Contents/MacOS/openclaw-mlx-tts");
        const cua = fixture.put("Contents/Resources/cua-driver");
        const worker = fixture.put(workerPath + "node");
        fixture.put("Contents/MacOS/OpenClaw");
        const sparkle = "Contents/Frameworks/Sparkle.framework";
        for (const member of [
          "Sparkle",
          "Autoupdate",
          "Updater.app/Contents/MacOS/Updater",
          "XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
          "XPCServices/Installer.xpc/Contents/MacOS/Installer",
        ]) {
          fixture.put(
            `${sparkle}/Versions/B/${member}`,
            member === "Autoupdate" ? machoFixture(64, false, true) : machoFixture(),
          );
        }
        const extra = fixture.put(
          `${sparkle}/Versions/B/Extras/extra.node`,
          machoFixture(64, true, false, 6),
        );
        const nested = fixture.put(
          "Contents/Frameworks/Outer.framework/Versions/A/Inner.framework/inner.dylib",
          machoFixture(64, true, false, 6),
        );
        const result = await fixture.run({}, false, fixture.app + suffix);
        expect(result.status, result.stderr).toBe(0);
        const signs = fixture
          .events()
          .filter(({ args }) => args.includes("--sign"))
          .map(({ args }) => args.at(-1));
        const expected = [
          helper,
          cua,
          worker,
          extra,
          nested,
          fixture.app,
          ...[
            `${sparkle}/Versions/B/Autoupdate`,
            `${sparkle}/Versions/B/Updater.app`,
            `${sparkle}/Versions/B/XPCServices/Downloader.xpc`,
            `${sparkle}/Versions/B/XPCServices/Installer.xpc`,
            sparkle,
            "Contents/Frameworks/Outer.framework/Versions/A/Inner.framework",
            "Contents/Frameworks/Outer.framework",
          ].map((member) => path.join(fixture.app, member)),
        ];
        expect(signs).toHaveLength(expected.length);
        expect(new Set(signs)).toEqual(new Set(expected));
        expect(signs.slice(0, 3)).toEqual([helper, cua, worker]);
        for (const child of signs) {
          for (const container of signs) {
            if (child && container && child.startsWith(container + "/")) {
              expect(signs.lastIndexOf(child), `${child} before ${container}`).toBeLessThan(
                signs.indexOf(container),
              );
            }
          }
        }
        expect(signs).toContain(nested);
        expect(signs.at(-1)).toBe(fixture.app);
      }),
  );

  it.concurrent.for([
    "mismatch",
    "metadata",
    "metadataFailure",
    "missingTeam",
    "format",
    "formatSkipTeam",
    "missingFormat",
    "verifyFailure",
    "authority",
    "appleEvents",
    "entitlementFailure",
  ])("fails closed on %s at the signing/audit boundary", (failure, { mac, expect }) =>
    mac.lifetime.run(async () => {
      const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-gates-"));
      const native = fixture.put(workerPath + "node");
      const config =
        failure === "formatSkipTeam"
          ? { format: native, skipTeam: true }
          : failure === "missingTeam"
            ? { metadata: "missing" }
            : failure === "missingFormat"
              ? { signatureFormat: "missing" }
              : {
                  [failure]:
                    failure === "metadata"
                      ? "failure"
                      : failure === "authority"
                        ? "Wrong Authority"
                        : native,
                };
      const result = await fixture.run(
        config,
        ["authority", "appleEvents", "entitlementFailure"].includes(failure),
      );
      expect(result.status, result.stdout).not.toBe(0);
      expect(result.stdout).not.toContain("Codesign complete");
    }),
  );

  it.concurrent.for(["valid", "team", "format", "authority", "missingTeam", "missingFormat"])(
    "uses signature metadata rather than filename text (%s)",
    (failure, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(
          mac,
          mac.createTempDir("openclaw-metadata-"),
          "Injected\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20400\nTeamIdentifier=FWJYW4S8P8\nAuthority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)\n.app",
        );
        const native = fixture.put(workerPath + "node");
        const configs: Record<string, Record<string, unknown>> = {
          valid: {},
          team: { mismatch: native },
          format: { format: native },
          authority: { authority: "Unexpected Authority" },
          missingTeam: { metadata: "missing" },
          missingFormat: { signatureFormat: "missing" },
        };
        const result = await fixture.run(configs[failure], failure === "authority");
        expect(
          fixture.events().some(({ args }) => args.includes("-dv")),
          result.stderr,
        ).toBe(true);
        if (failure === "valid") {
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Codesign complete");
        } else {
          expect(result.status, result.stdout + result.stderr).not.toBe(0);
          expect(result.stdout).not.toContain("Codesign complete");
        }
      }),
  );

  it.concurrent.for(["before", "after"])(
    "does not consume failed or partial inventory %s signing",
    (phase, { mac, expect }) =>
      mac.lifetime.run(async () => {
        for (const fault of [
          "scanner",
          "walk",
          "spawn",
          "classifier",
          "empty",
          "partial",
          "unterminated",
          "error-record",
        ]) {
          const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-failure-"));
          const native = fixture.put(workerPath + "node");
          fixture.put(workerPath + "addon", machoFixture(64, true, false, 6));
          const result = await fixture.run({ fault, phase, partialPath: native });
          expect(result.status, `${phase}/${fault}: ${result.stdout}`).not.toBe(0);
          expect(result.stdout).not.toContain("Codesign complete");
          if (phase === "before") {
            expect(fixture.events().filter(({ args }) => args.includes("--sign"))).toEqual([]);
          }
        }
      }),
  );

  it.concurrent.for(["team", "entitlement"])(
    "audits native files created while signing the app (%s)",
    (gate, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const fixture = makeSigningFixture(mac, mac.createTempDir("openclaw-inventory-fresh-"));
        fixture.put(workerPath + "node");
        const generated = path.join(fixture.worker, "generated-after-sign.node");
        const result = await fixture.run(
          {
            generated,
            generatedHex: machoFixture(64, true, false, 6).toString("hex"),
            ...(gate === "team" ? { mismatch: generated } : { appleEvents: generated }),
          },
          gate === "entitlement",
        );
        expect(result.status, result.stdout).not.toBe(0);
        expect(
          fixture
            .events()
            .some(
              ({ args }) =>
                args.at(-1) === generated && args.includes(gate === "team" ? "-dv" : "-d"),
            ),
        ).toBe(true);
      }),
  );
});
