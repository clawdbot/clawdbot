import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import {
  addon,
  artifactFixture,
  buildInfo,
  library,
  peekabooCommit,
  sourceCommit,
  workerDist,
  workerRoot,
  write,
} from "./mac-elevation-artifact.test-support.js";
import {
  compiledMacNativeFixtures,
  macFatContainerFixture,
  macObjectFixture,
  runMacFixtureTool,
  singleSliceMacFat64,
} from "./mac-native-fixtures.test-support.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();

const machResourceKinds = [
  "object",
  "synthetic-core",
  "synthetic-dylib-stub",
  "synthetic-dsym",
] as const;

function withMachResourceKind(
  contents: Buffer,
  kind: (typeof machResourceKinds)[number] | "archive",
) {
  if (kind === "archive") {
    return contents;
  }
  const bytes = Buffer.from(contents);
  // lipo -create ignores MH_CORE inputs. Build real object containers first, then
  // change only their object header kinds: these are synthetic controls, not dumps.
  const filetypes = {
    object: 1,
    "synthetic-core": 4,
    "synthetic-dylib-stub": 9,
    "synthetic-dsym": 10,
  };
  const magic = bytes.readUInt32BE(0);
  const offsets = [0];
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const fat64 = magic === 0xcafebabf;
    expect(bytes.readUInt32BE(4)).toBe(2);
    offsets.length = 0;
    for (let index = 0; index < 2; index++) {
      const entry = 8 + index * (fat64 ? 32 : 20);
      offsets.push(
        fat64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8),
      );
    }
  }
  for (const offset of offsets) {
    expect(bytes.readUInt32BE(offset)).toBe(0xcffaedfe);
    if (bytes.readUInt32LE(offset + 12) === 1) {
      bytes.writeUInt32LE(filetypes[kind], offset + 12);
    }
  }
  return bytes;
}

describe.skipIf(process.platform !== "darwin")(
  "portable elevation native artifact verification",
  () => {
    // The following archive case owns a new lifetime and must prepare successfully
    // after this failed flight; keep the failure probe ahead of the concurrent cases.
    it("rejects all borrowers of a failed native preparation", ({ mac }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-native-preparation-failure-");
        const tool = vi.spyOn(mac, "run").mockResolvedValueOnce({
          status: 1,
          signal: null,
          error: undefined,
          stdout: "",
          stderr: "injected native preparation failure",
        });
        try {
          const results = await Promise.allSettled([
            compiledMacNativeFixtures(root, mac),
            macObjectFixture(root, "arm64", mac),
          ]);
          const rejected = {
            status: "rejected",
            reason: expect.objectContaining({
              message: expect.stringContaining("injected native preparation failure"),
            }),
          };
          expect(results).toEqual([rejected, rejected]);
          expect(tool).toHaveBeenCalledTimes(1);
        } finally {
          tool.mockRestore();
        }
      }));

    it.concurrent("accepts a real archive with a complete native worker pair outside the checkout", async ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          `Elevation artifact verified: source=${sourceCommit} peekaboo=${peekabooCommit}`,
        );
        const calls = readFileSync(harness.calls, "utf8");
        expect(
          calls.match(/^codesign --verify --deep --strict --all-architectures /gm),
        ).toHaveLength(1);
        expect(calls.match(/^helper-authority=.*$/gm)).toEqual(["helper-authority=:"]);
        expect(calls.indexOf("candidate-helper-hash")).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf("candidate-helper-hash")).toBeLessThan(
          calls.indexOf("codesign --verify --deep"),
        );
        expect(calls).toContain("codesign -dv --verbose=4 --arch arm64 ");
        expect(calls).toContain("codesign -dv --verbose=4 --arch x86_64 ");
        expect(calls).toContain("codesign --verify --strict --test-requirement==notarized ");
        expect(calls).toContain("xcrun stapler validate ");
        expect(calls).toContain("spctl --assess --type execute ");
        for (const arch of ["arm64", "x86_64"]) {
          expect(calls).toContain(`/${arch}/${addon}`);
          expect(calls).toContain(`/${arch}/${library}`);
        }
      }));

    it.concurrent.for(["extra-entry", "regular-file", "symlink"])(
      "rejects an archive with an invalid app root (%s) before authenticating a helper",
      async (kind, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          if (kind === "extra-entry") {
            await write(path.join(path.dirname(harness.app), "unexpected"), "not app content\n");
          } else {
            const reference = path.join(harness.home, "reference.app");
            await rename(harness.app, reference);
            if (kind === "symlink") {
              await symlink(reference, harness.app);
            } else {
              await write(harness.app, "not an app directory\n");
            }
          }
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation archive root");
          expect(result.stdout).not.toContain("Elevation artifact verified");
          const calls = readFileSync(harness.calls, "utf8");
          expect(calls).not.toContain("candidate-helper-hash");
          expect(calls).not.toContain("codesign --verify");
        }),
    );

    it.concurrent("accepts universal worker slices and contained terminal symlinks", async ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        for (const arch of ["arm64", "x86_64"]) {
          const node = harness.at(`${workerRoot}/${arch}/bin/node`);
          await rename(node, `${node}-real\n`);
          await write(`${node}-real\n`, harness.binaries.universal, 0o755);
          await symlink("node-real\n", node);
        }
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Elevation artifact verified");
      }));

    it.concurrent("batches native classification across resource-heavy worker trees", async ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        for (const arch of ["arm64", "x86_64"]) {
          for (let index = 0; index < 40; index++) {
            await write(
              harness.at(`${workerRoot}/${arch}/nested/win32/resource [*]?\n${index}.js`),
              `// harmless platform resource ${index}\n`,
            );
          }
        }
        const result = await harness.verifyCode();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("Elevation code verified\n");
        const count = harness.fileCallCount();
        console.info(`portable verifier: 80 resources, ${count} file classifier invocations`);
        // Allow different batch sizes, but never one process per resource.
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(12);
        for (const arch of ["arm64", "x86_64"]) {
          expect(readFileSync(harness.calls, "utf8")).toContain(`/${arch}/${addon}`);
        }
      }));

    it.concurrent.for([
      ["shared", "Contents/Frameworks/shared [fixture].dylib", "arm64", 0o755, false],
      ["arm64 addon", `${workerRoot}/arm64/${addon}`, "x86_64", 0o644, false],
      ["x86_64 addon", `${workerRoot}/x86_64/${addon}`, "arm64", 0o644, false],
      ["arm64 archive", `${workerRoot}/arm64/lib/native.a`, "x86_64", 0o644, true],
      ["x86_64 archive", `${workerRoot}/x86_64/lib/native.a`, "arm64", 0o644, true],
    ] as const)(
      "rejects wrong fat64 slices in %s code",
      async ([_name, relative, arch, mode, archive], { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const bytes = archive
            ? await macFatContainerFixture(
                harness.home,
                [harness.binaries[arch === "arm64" ? "armArchive" : "intelArchive"]],
                true,
                mac,
              )
            : await singleSliceMacFat64(harness.home, arch, mac);
          await write(harness.at(relative), bytes, mode);
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(
            relative.startsWith(workerRoot)
              ? `elevation worker Mach-O lacks ${arch === "arm64" ? "x86_64" : "arm64"}:`
              : "elevation Mach-O is not universal:",
          );
          expect(result.stderr).toContain(relative);
        }),
    );

    it.concurrent.for([
      "Contents/Frameworks/shared [fixture].dylib",
      `${workerRoot}/arm64/${addon}`,
    ])("rejects malformed fat64 code at %s", async (relative, { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        await write(harness.at(relative), Buffer.from("cafebabf", "hex"), 0o755);
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("could not inspect elevation code slices:");
        expect(result.stderr).toContain(relative);
      }),
    );

    it.concurrent.for(
      ["arm64", "x86_64"].flatMap((arch) => [
        `generic-native-${arch}`,
        `missing-native-format-${arch}`,
      ]),
    )("rejects %s signatures despite successful app policy verification", async (fault, { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const result = await harness.verify(fault);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation code lacks native signature format:");
        expect(result.stderr).toContain(addon);
        expect(readFileSync(harness.calls, "utf8")).toContain("spctl --assess --type execute");
      }),
    );

    it.concurrent.for([
      ["Contents/MacOS/OpenClaw", false],
      [`${workerRoot}/arm64/${addon}`, true],
    ] as const)(
      "rejects generic raw-fat64 signatures at %s",
      async ([relative, libraryImage], { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const bytes = libraryImage
            ? await macFatContainerFixture(
                harness.home,
                [harness.binaries.armLibrary, harness.binaries.intelLibrary],
                true,
                mac,
              )
            : harness.binaries.fat64;
          await write(harness.at(relative), bytes, libraryImage ? 0o644 : 0o755);
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation code lacks native signature format:");
          expect(result.stderr).toContain(relative);
        }),
    );

    it.concurrent.for(
      (["archive", ...machResourceKinds] as const).flatMap((resource) =>
        [false, true].flatMap((fat64) =>
          [false, true].map((archiveFirst) => ({ resource, fat64, archiveFirst })),
        ),
      ),
    )(
      "rejects mixed $resource/native containers (fat64=$fat64, archiveFirst=$archiveFirst)",
      async ({ resource, fat64, archiveFirst }, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const armResource =
            resource === "archive"
              ? harness.binaries.armArchive
              : await macObjectFixture(harness.home, "arm64", mac);
          const intelResource =
            resource === "archive"
              ? harness.binaries.intelArchive
              : await macObjectFixture(harness.home, "x86_64", mac);
          const mixed = await macFatContainerFixture(
            harness.home,
            archiveFirst
              ? [harness.binaries.armLibrary, intelResource]
              : [armResource, harness.binaries.intelLibrary],
            fat64,
            mac,
          );
          await write(
            harness.at(`${workerRoot}/arm64/${addon}`),
            withMachResourceKind(mixed, resource),
          );
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(
            `mixed ${resource === "archive" ? "archive" : "resource"}/native elevation code:`,
          );
        }),
    );

    it.concurrent("rejects a malformed sibling slice in an otherwise compatible fat container", async ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const bytes = Buffer.from(harness.binaries.universalArchive);
        expect(bytes.readUInt32BE(0)).toBe(0xcafebabe);
        expect(bytes.readUInt32BE(8)).toBe(0x01000007); // x86_64 comes first in lipo output.
        bytes.fill(0, bytes.readUInt32BE(16), bytes.readUInt32BE(16) + 8);
        await write(harness.at(`${workerRoot}/arm64/${addon}`), bytes);
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("invalid elevation code slice:");
        expect(result.stderr).toContain(`${workerRoot}/arm64/${addon} (x86_64)`);
        expect(result.stdout).not.toContain("Elevation artifact verified");
      }));

    it.concurrent.for(
      (["archive", ...machResourceKinds] as const).flatMap((resource) =>
        ["thin", "fat32", "fat64"].map((format) => ({ resource, format })),
      ),
    )(
      "rejects $resource resources posing as Node ($format)",
      async ({ resource, format }, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const arm =
            resource === "archive"
              ? harness.binaries.armArchive
              : await macObjectFixture(harness.home, "arm64", mac);
          const intel =
            resource === "archive"
              ? harness.binaries.intelArchive
              : await macObjectFixture(harness.home, "x86_64", mac);
          const bytes =
            format !== "thin"
              ? await macFatContainerFixture(harness.home, [arm, intel], format === "fat64", mac)
              : arm;
          await write(
            harness.at(`${workerRoot}/arm64/bin/node`),
            withMachResourceKind(bytes, resource),
            0o755,
          );
          const result = await harness.verify(`${resource}-node`);
          expect(result.status, result.stderr).toBe(1);
          expect(result.stdout).not.toContain("Elevation artifact verified");
          expect(result.stderr).toContain(
            resource === "archive" ? "elevation worker Node must be Mach-O:" : "/arm64/bin/node",
          );
        }),
    );

    it.concurrent.for(
      machResourceKinds.flatMap((resource) =>
        ["thin", "fat32", "fat64"].map((format) => ({ resource, format })),
      ),
    )(
      "accepts $format $resource resources without changing bytes or modes",
      async ({ resource, format }, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const objects = {
            arm64: await macObjectFixture(harness.home, "arm64", mac),
            x86_64: await macObjectFixture(harness.home, "x86_64", mac),
          };
          const universal =
            format === "thin"
              ? undefined
              : await macFatContainerFixture(
                  harness.home,
                  [objects.arm64, objects.x86_64],
                  format === "fat64",
                  mac,
                );
          const preserved = [];
          for (const arch of ["arm64", "x86_64"] as const) {
            for (const mode of [0o644, 0o755]) {
              const target = harness.at(
                `${workerRoot}/${arch}/lib/object-resource [*]\n${mode}.dylib`,
              );
              const bytes = withMachResourceKind(universal ?? objects[arch], resource);
              await write(target, bytes, mode);
              preserved.push({ target, bytes, mode });
            }
          }
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Elevation artifact verified");
          const inspected = await harness.verifyCode();
          expect(inspected.status, inspected.stderr).toBe(0);
          for (const { target, bytes, mode } of preserved) {
            expect(readFileSync(target), target).toEqual(bytes);
            expect(statSync(target).mode & 0o777, target).toBe(mode);
          }
          const calls = readFileSync(harness.calls, "utf8");
          expect(calls).toContain("codesign --verify --deep --strict --all-architectures");
          expect(
            calls
              .split("\n")
              .filter(
                (line) =>
                  line.startsWith("codesign -dv --verbose=4") && line.includes("object-resource"),
              ),
          ).toEqual([]);
        }),
    );

    it.concurrent.for(
      ["arm64", "x86_64"].flatMap((arch) =>
        ["thin", "fat32", "fat64"].map((format) => ({ arch, format })),
      ),
    )(
      "rejects wrong-architecture $format object resources in $arch",
      async ({ arch, format }, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const wrong = await macObjectFixture(
            harness.home,
            arch === "arm64" ? "x86_64" : "arm64",
            mac,
          );
          const bytes =
            format === "thin"
              ? wrong
              : await macFatContainerFixture(harness.home, [wrong], format === "fat64", mac);
          // lipo -info repeats the path: injected architecture text is still a filename.
          const relative = `${workerRoot}/${arch}/lib/object-resource are: arm64 x86_64\nNon-fat file: injected is architecture: ${arch}`;
          await write(harness.at(relative), bytes);
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(`elevation worker Mach-O lacks ${arch}:`);
          expect(result.stderr).toContain(relative);
        }),
    );

    it.concurrent.for(
      ["arm64", "x86_64"].flatMap((arch) =>
        ["empty", "missing-member"].map((kind) => ({ arch, kind })),
      ),
    )("rejects $kind GNU thin archives in $arch", async ({ arch, kind }, { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const header = [
          "missing.o/".padEnd(16),
          "0".padEnd(12),
          "0".padEnd(6),
          "0".padEnd(6),
          "100644".padEnd(8),
          "0".padEnd(10),
          "`\n",
        ].join("");
        const target = harness.at(`${workerRoot}/${arch}/lib/opaque [*].resource`);
        await write(target, `!<thin>\n${kind === "empty" ? "" : header}`);
        expect(
          await runMacFixtureTool("/usr/bin/file", ["-b", target], harness.home, mac),
        ).toContain("thin archive with");
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation worker contains unsupported thin archive:");
        expect(result.stdout).not.toContain("Elevation artifact verified");
      }),
    );

    it.concurrent("accepts universal native code, static archives, tar and Java resources without changing bytes or modes", async ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        await write(path.join(harness.home, "ordinary.txt"), "ordinary resource\n");
        const tar = path.join(harness.home, "ordinary.tar");
        await runMacFixtureTool(
          "/usr/bin/tar",
          ["--format", "ustar", "-cf", tar, "-C", harness.home, "ordinary.txt"],
          harness.home,
          mac,
        );
        expect(await runMacFixtureTool("/usr/bin/file", ["-b", tar], harness.home, mac)).toBe(
          "POSIX tar archive",
        );
        const targets = [
          "Contents/Frameworks/shared [fixture].dylib",
          ...["arm64", "x86_64"].flatMap((arch) => [
            `${workerRoot}/${arch}/bin/node`,
            `${workerRoot}/${arch}/${addon}`,
          ]),
        ];
        for (const relative of targets) {
          await write(
            harness.at(relative),
            harness.binaries.universal,
            relative.endsWith(addon) ? 0o644 : 0o755,
          );
        }
        // Shared slice enforcement retains find -perm -111 semantics, not just -x.
        for (const mode of [0o644, 0o700, 0o750]) {
          await write(
            harness.at(`Contents/Frameworks/thin-${mode}.dylib`),
            harness.binaries.armLibrary,
            mode,
          );
        }
        const archive64 = await macFatContainerFixture(
          harness.home,
          [harness.binaries.armArchive, harness.binaries.intelArchive],
          true,
          mac,
        );
        for (const arch of ["arm64", "x86_64"]) {
          await write(harness.at(`${workerRoot}/${arch}/ordinary.resource`), readFileSync(tar));
          await write(
            harness.at(`${workerRoot}/${arch}/lib/universal.a`),
            harness.binaries.universalArchive,
          );
          await write(harness.at(`${workerRoot}/${arch}/lib/archive64 [*]`), archive64);
          await write(
            harness.at(`${workerRoot}/${arch}/Example.class`),
            Buffer.from("cafebabe0000003400010001000000000000000000000000", "hex"),
          );
        }
        const preserved = [
          ...targets,
          "Contents/MacOS/OpenClaw",
          "Contents/MacOS/openclaw-mlx-tts",
          ...[0o644, 0o700, 0o750].map((mode) => `Contents/Frameworks/thin-${mode}.dylib`),
          ...["arm64", "x86_64"].flatMap((arch) =>
            [
              library,
              "lib/native.a",
              "lib/universal.a",
              "lib/archive64 [*]",
              "Example.class",
              "ordinary.resource",
            ].map((relative) => `${workerRoot}/${arch}/${relative}`),
          ),
        ].map((relative) => ({
          relative,
          bytes: readFileSync(harness.at(relative)),
          mode: statSync(harness.at(relative)).mode & 0o777,
        }));
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Elevation artifact verified");
        // verifyCode receives this tree; verify above inspects a separate ZIP extraction.
        const code = await harness.verifyCode();
        expect(code.status, code.stderr).toBe(0);
        expect(code.stdout).toBe("Elevation code verified\n");
        for (const { relative, bytes, mode } of preserved) {
          expect(readFileSync(harness.at(relative)), relative).toEqual(bytes);
          expect(statSync(harness.at(relative)).mode & 0o777, relative).toBe(mode);
        }
      }));

    it.concurrent.for(
      (
        [
          ["Contents", "contents"],
          ["Contents/Resources", "Contents/resources"],
          [workerRoot, "Contents/Resources/Node-Worker"],
        ] as const
      ).flatMap(([relative, alias]) =>
        ["wrong-slice", "escaping-link"].map((fault) => ({ relative, alias, fault })),
      ),
    )(
      "rejects case-aliased worker structure $relative ($fault)",
      async ({ relative, alias, fault }, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          for (const arch of ["arm64", "x86_64"]) {
            await write(
              harness.at(`${workerRoot}/${arch}/bin/node`),
              harness.binaries.universal,
              0o755,
            );
          }
          const target = harness.at(`${workerRoot}/arm64/${addon}`);
          if (fault === "wrong-slice") {
            await write(target, harness.binaries.intelLibrary);
          } else {
            const outside = path.join(harness.home, "outside-addon");
            await rename(target, outside);
            await symlink(outside, target);
          }
          await rename(harness.at(relative), harness.at(alias));
          expect(readdirSync(path.dirname(harness.at(alias)))).toContain(path.basename(alias));
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("canonical directory spelling required");
        }),
    );

    it.concurrent.for([
      ["both workers", workerRoot],
      ["arm64 worker", `${workerRoot}/arm64`],
      ["x86_64 worker", `${workerRoot}/x86_64`],
    ] as const)("rejects missing %s", async ([_name, relative], { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        await rm(harness.at(relative), { recursive: true });
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation worker directory missing or symlinked:");
      }),
    );

    it.concurrent.for(["arm64", "x86_64"] as const)(
      "rejects wrong slices throughout the %s worker",
      async (arch, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const wrongArch = arch === "arm64" ? "x86_64" : "arm64";
          const cases = [
            ["bin/node", harness.binaries[wrongArch], 0o755],
            [addon, harness.binaries[arch === "arm64" ? "intelLibrary" : "armLibrary"], 0o644],
            [library, harness.binaries[arch === "arm64" ? "intelLibrary" : "armLibrary"], 0o644],
            [
              "lib/native.a",
              harness.binaries[arch === "arm64" ? "intelArchive" : "armArchive"],
              0o644,
            ],
            ["lib/space [glob]*\naddon.node", harness.binaries[wrongArch], 0o644],
          ] as const;
          for (const [relative, contents, mode] of cases) {
            const target = harness.at(`${workerRoot}/${arch}/${relative}`);
            const original = existsSync(target) ? readFileSync(target) : undefined;
            await write(target, contents, mode);
            const result = await harness.verify();
            expect(result.status, `${relative}: ${result.stderr}`).toBe(1);
            expect(result.stderr).toContain(`elevation worker Mach-O lacks ${arch}:`);
            expect(result.stderr).toContain(relative);
            if (original) {
              await write(target, original, mode);
            } else {
              await rm(target);
            }
          }
        }),
    );

    it.concurrent.for(["bin/node", `${workerDist}/entry.js`, `${workerDist}/build-info.json`])(
      "rejects an incomplete worker missing %s",
      async (relative, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          await rm(harness.at(`${workerRoot}/x86_64/${relative}`));
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          // The npm-style entrypoint link must also remain valid when its target disappears.
          expect(result.stderr).toMatch(
            /elevation worker payload is incomplete|broken or cyclic elevation worker symlink/,
          );
        }),
    );

    it.concurrent.for(["version", "commit", "builtAt", "buildId"] as const)(
      "rejects mismatched worker %s",
      async (key, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          await write(
            harness.at(`${workerRoot}/x86_64/${workerDist}/build-info.json`),
            JSON.stringify({ ...buildInfo, [key]: "wrong" }),
          );
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation worker build metadata does not match app:");
          expect(result.stderr).toContain("/x86_64");
        }),
    );

    it.concurrent("rejects missing app build identity and executable non-Mach-O Node", async ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const node = harness.at(`${workerRoot}/arm64/bin/node`);
        await write(node, "#!/bin/sh\nexit 97\n", 0o755);
        const nonNative = await harness.verify();
        expect(nonNative.status, nonNative.stderr).toBe(1);
        expect(nonNative.stderr).toContain("elevation worker Node must be Mach-O:");
        await write(node, harness.binaries.arm64, 0o755);
        await runMacFixtureTool(
          "/usr/bin/plutil",
          ["-remove", "OpenClawWorkerBuildID", harness.at("Contents/Info.plist")],
          harness.home,
          mac,
        );
        const missingIdentity = await harness.verify("plist-error-stdout");
        expect(missingIdentity.status, missingIdentity.stderr).toBe(1);
        expect(missingIdentity.stderr).toContain("elevation app is missing worker build identity");
      }));

    it.concurrent.for(["directory", "file", "symlink"])(
      "rejects an unexpected worker architecture %s",
      async (kind, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const extra = harness.at(`${workerRoot}/unexpected [arch]`);
          if (kind === "directory") {
            await mkdir(extra);
          } else if (kind === "symlink") {
            await symlink("arm64", extra);
          } else {
            await write(extra, "unexpected");
          }
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("unexpected elevation worker architecture entry:");
        }),
    );

    it.concurrent.for([
      "Contents",
      "Contents/Resources",
      workerRoot,
      `${workerRoot}/arm64`,
      `${workerRoot}/arm64/bin`,
      `${workerRoot}/arm64/lib/node_modules/openclaw`,
      `${workerRoot}/arm64/bin/node`,
      `${workerRoot}/arm64/${workerDist}/entry.js`,
      `${workerRoot}/arm64/${workerDist}/build-info.json`,
      `${workerRoot}/arm64/${addon}`,
    ])(
      "rejects an escaping root, intermediate, or terminal link at %s",
      async (relative, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const target = harness.at(relative);
          const outside = path.join(harness.home, "outside-worker");
          await rename(target, outside);
          await symlink(outside, target);
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toMatch(
            /elevation worker directory missing or symlinked|elevation worker symlink escapes its architecture tree/,
          );
        }),
    );

    it.concurrent.for([
      "dangling",
      "terminal-cycle",
      "directory-cycle",
      "indirect-directory-cycle",
      "cross-worker",
    ])("rejects %s worker links", async (kind, { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const worker = harness.at(`${workerRoot}/arm64`);
        if (kind === "directory-cycle") {
          await symlink(".", path.join(worker, "loop"));
        } else if (kind === "indirect-directory-cycle") {
          await mkdir(path.join(worker, "a"));
          await mkdir(path.join(worker, "b"));
          await symlink("../b", path.join(worker, "a/to-b"));
          await symlink("../a", path.join(worker, "b/to-a"));
        } else if (kind === "cross-worker") {
          await symlink("../x86_64", path.join(worker, "other-worker"));
        } else {
          const node = path.join(worker, "bin/node");
          await rm(node);
          await symlink(kind === "dangling" ? "missing" : "node", node);
        }
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          kind.endsWith("directory-cycle")
            ? "cyclic or unreadable elevation worker tree"
            : kind === "cross-worker"
              ? "elevation worker symlink escapes its architecture tree"
              : "broken or cyclic elevation worker symlink",
        );
      }),
    );

    it.concurrent.for([
      "Contents/MacOS/OpenClaw",
      "Contents/MacOS/openclaw-mlx-tts",
      "Contents/Frameworks/shared [fixture].dylib",
    ])("rejects thin shared code at %s", async (relative, { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        await write(
          harness.at(relative),
          relative.endsWith(".dylib") ? harness.binaries.armLibrary : harness.binaries.x86_64,
          0o755,
        );
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation Mach-O is not universal:");
        expect(result.stderr).toContain(relative);
      }),
    );

    it.concurrent.for([
      [
        "team-arm64",
        1,
        "must be signed for every architecture",
        "codesign -dv --verbose=4 --arch arm64",
      ],
      [
        "team-x86_64",
        1,
        "must be signed for every architecture",
        "codesign -dv --verbose=4 --arch x86_64",
      ],
      [
        "authority-arm64",
        1,
        "must be signed for every architecture",
        "codesign -dv --verbose=4 --arch arm64",
      ],
      [
        "authority-x86_64",
        1,
        "must be signed for every architecture",
        "codesign -dv --verbose=4 --arch x86_64",
      ],
      [
        "signature",
        1,
        "must be signed for every architecture",
        "codesign --verify --deep --strict --all-architectures",
      ],
      [
        "notarized",
        23,
        "mock rejection: notarized",
        "codesign --verify --strict --test-requirement==notarized",
      ],
      ["stapler", 23, "mock rejection: stapler", "xcrun stapler validate"],
      ["spctl", 23, "mock rejection: spctl", "spctl --assess --type execute"],
      ["apple-events", 1, "Apple Events entitlement remains on elevation code:", `/arm64/${addon}`],
      ["bundle-events", 1, "Apple Events entitlement remains on elevation bundle:", "/fixture.xpc"],
      [
        "mlx",
        1,
        "MLX helper must be signed without app entitlements:",
        "/Contents/MacOS/openclaw-mlx-tts",
      ],
      [
        "cdhash-arm64",
        1,
        "artifact receipt arm64 CDHash mismatch",
        "codesign -dv --verbose=4 --arch arm64",
      ],
      [
        "cdhash-x86_64",
        1,
        "artifact receipt x86_64 CDHash mismatch",
        "codesign -dv --verbose=4 --arch x86_64",
      ],
    ] as const)(
      "preserves the %s policy gate with observable mocks",
      async ([fault, code, diagnostic, command], { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          await mkdir(harness.at(`${workerRoot}/arm64/fixture.xpc`));
          const result = await harness.verify(fault);
          expect(result.status, result.stderr).toBe(code);
          expect(result.stderr).toContain(diagnostic);
          expect(readFileSync(harness.calls, "utf8")).toContain(command);
          expect(result.stdout).not.toContain("Elevation artifact verified");
        }),
    );

    it.concurrent.for([
      ["find-code", "could not scan elevation code"],
      ["find-links", "cyclic or unreadable elevation worker tree"],
      ["file", "could not inspect elevation code:"],
      ["file-empty", "invalid elevation code classification:"],
      ["file-missing-description", "invalid elevation code classification:"],
      ["file-unterminated-description", "invalid elevation code classification:"],
      ["file-empty-description", "invalid elevation code classification:"],
      ["file-mismatched-path", "invalid elevation code classification:"],
      ["file-trailing-byte", "unexpected trailing elevation code classification"],
      ["file-extra-record", "unexpected trailing elevation code classification"],
      ["file-partial-error", "could not inspect elevation code:"],
      ["file-changed-type", "elevation code changed type during classification:"],
      ["lipo", "could not inspect elevation code slices:"],
    ])("fails closed when %s cannot scan the artifact", async ([fault, diagnostic], { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        const result = await harness.verify(fault);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).not.toContain("Elevation artifact verified");
      }),
    );

    it.concurrent.for(["file", "symlink"])(
      "preserves CUA omission for a driver %s",
      async (kind, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const driver = harness.at("Contents/Resources/cua-driver");
          if (kind === "file") {
            await write(driver, "inert driver");
          } else {
            await symlink("missing-driver", driver);
          }
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation app must not contain bundled CUA driver:");
        }),
    );
    it.concurrent.for(["{", `${JSON.stringify(buildInfo)}\n${JSON.stringify(buildInfo)}`])(
      "rejects noncanonical build metadata %s",
      async (metadata, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          await write(harness.at(`${workerRoot}/arm64/${workerDist}/build-info.json`), metadata);
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation worker build metadata does not match app:");
        }),
    );

    it.concurrent.for(["healthy", "signature", "notarized", "stapler", "spctl"])(
      "fully verifies a new destination-stage copy with %s policy",
      async (fault, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const result = await harness.verifyStagedCopy(fault);
          expect(result.status, result.stderr).toBe(
            fault === "healthy" ? 0 : fault === "signature" ? 1 : 23,
          );
          const checks = readFileSync(harness.calls, "utf8")
            .split("\n")
            .filter((line) =>
              line.startsWith("codesign --verify --deep --strict --all-architectures "),
            );
          expect(checks).toHaveLength(1);
          expect(checks[0]).toContain(`${harness.home}/stage-destination.app.incoming-`);
          expect(
            readdirSync(harness.home).filter((name) =>
              name.startsWith("stage-destination.app.incoming-"),
            ),
          ).toEqual([]);
          if (fault === "healthy") {
            expect(result.stdout).toContain("Staged copy verified:");
          } else {
            expect(result.stdout).not.toContain("Staged copy verified:");
          }
        }),
    );

    it.concurrent.for([
      ["sourceCommit", "OpenClaw source"],
      ["peekabooCommit", "Peekaboo source"],
      ["version", "version"],
      ["build", "build"],
      ["authority", "signing authority"],
      ["teamIdentifier", "TeamIdentifier"],
    ] as const)("binds receipt %s to the fully audited app", async ([key, diagnostic], { mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        harness.receipt[key] = "wrong";
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(`artifact receipt ${diagnostic} mismatch`);
        expect(result.stdout).not.toContain("Elevation artifact verified");
        expect(readFileSync(harness.calls, "utf8")).toContain("spctl --assess --type execute");
      }),
    );

    it.concurrent.for(
      (["architectures", "entitlementsSha256"] as const).flatMap((field) =>
        (["main", "helper"] as const).map((target) => ({ field, target })),
      ),
    )(
      "binds receipt $field for $target to the fully audited app",
      async ({ field, target }, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          harness.receipt[field][target] = "wrong";
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(
            `artifact receipt ${target} ${field === "architectures" ? "architecture" : "entitlement"} mismatch`,
          );
          expect(result.stdout).not.toContain("Elevation artifact verified");
        }),
    );

    it.concurrent.for(["notarized", "stapler", "spctl"])(
      "propagates %s failure through conditional receipt verification",
      async (fault, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const result = await harness.verifyReceiptConditionally(fault);
          expect(result.status, result.stderr).toBe(23);
          expect(result.stderr).toContain(`mock rejection: ${fault}`);
          expect(result.stdout).not.toContain("Conditional receipt accepted");
        }),
    );

    it.concurrent.for([
      ["healthy", "valid", "spctl --assess --type execute"],
      ["notarized", "damaged", "codesign --verify --strict --test-requirement==notarized"],
      ["stapler", "damaged", "xcrun stapler validate"],
      ["spctl", "damaged", "spctl --assess --type execute"],
    ] as const)(
      "classifies recovery planning after %s policy result",
      async ([fault, state, command], { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          const result = await harness.recoveryPlan(fault);
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe(`Recovery planning state: ${state}\n`);
          const calls = readFileSync(harness.calls, "utf8");
          expect(calls).toContain(command);
          expect(calls).toContain("stable-recovery-identity");
        }),
    );

    it.concurrent.for(["elf", "pe", "coff"] as const)(
      "rejects foreign %s worker assets even without executable bits",
      async (format, { mac }) =>
        mac.lifetime.run(async () => {
          const harness = await artifactFixture(mac);
          await write(harness.at(`${workerRoot}/arm64/${addon}`), harness.binaries[format]);
          const result = await harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation worker contains non-Mach-O native code:");
        }),
    );
  },
);
