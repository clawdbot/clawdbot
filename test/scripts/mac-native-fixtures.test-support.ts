import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

export function runMacFixtureTool(command: string, args: string[], root: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: systemPath },
  });
  expect(result.status, `${command}: ${result.error ?? result.stderr}`).toBe(0);
  return result.stdout.trim();
}

type NativeFixtures = Record<
  | "arm64"
  | "x86_64"
  | "universal"
  | "fat64"
  | "universalArchive"
  | "coff"
  | "pe"
  | "armLibrary"
  | "intelLibrary"
  | "universalLibrary"
  | "elf"
  | "armArchive"
  | "intelArchive",
  Buffer
>;
let nativeFixtures: NativeFixtures | undefined;
const nativeObjects = new Map<"arm64" | "x86_64", Buffer>();

export function macObjectFixture(root: string, arch: "arm64" | "x86_64") {
  compiledMacNativeFixtures(root);
  const object = nativeObjects.get(arch);
  if (!object) {
    throw new Error(`Missing compiled ${arch} object fixture`);
  }
  return object;
}

export function macFatContainerFixture(root: string, slices: readonly Buffer[], fat64 = false) {
  const inputs = slices.map((bytes, index) => {
    const file = path.join(root, `fat-container-input-${index}`);
    writeFileSync(file, bytes);
    return file;
  });
  const output = path.join(root, "fat-container");
  runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", ...(fat64 ? ["-fat64"] : []), ...inputs, "-output", output],
    root,
  );
  return readFileSync(output);
}

export function singleSliceMacFat64(root: string, arch: "arm64" | "x86_64"): Buffer {
  const input = path.join(root, `fat64-input-${arch}`);
  const output = path.join(root, `fat64-single-${arch}`);
  writeFileSync(input, compiledMacNativeFixtures(root)[arch]);
  runMacFixtureTool("/usr/bin/lipo", ["-create", "-fat64", input, "-output", output], root);
  expect(runMacFixtureTool("/usr/bin/lipo", ["-archs", output], root)).toBe(arch);
  const bytes = readFileSync(output);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("cafebabf");
  return bytes;
}

export function compiledMacNativeFixtures(root: string): NativeFixtures {
  if (nativeFixtures) {
    return nativeFixtures;
  }
  const source = path.join(root, "inert.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  const files = {
    arm64: path.join(root, "arm64"),
    x86_64: path.join(root, "x86_64"),
    universal: path.join(root, "universal"),
    fat64: path.join(root, "fat64"),
    universalArchive: path.join(root, "universal.a"),
    coff: path.join(root, "windows.obj"),
    armLibrary: path.join(root, "arm-library"),
    intelLibrary: path.join(root, "intel-library"),
    universalLibrary: path.join(root, "universal-library"),
    elf: path.join(root, "elf"),
    armArchive: path.join(root, "arm.a"),
    intelArchive: path.join(root, "intel.a"),
  };
  for (const arch of ["arm64", "x86_64"] as const) {
    for (const dynamic of [false, true]) {
      const output = dynamic
        ? files[arch === "arm64" ? "armLibrary" : "intelLibrary"]
        : files[arch];
      runMacFixtureTool(
        "/usr/bin/xcrun",
        [
          "clang",
          "-arch",
          arch,
          "-mmacosx-version-min=14.0",
          "-Wl,-no_adhoc_codesign",
          ...(dynamic ? ["-dynamiclib"] : []),
          source,
          "-o",
          output,
        ],
        root,
      );
      expect(runMacFixtureTool("/usr/bin/lipo", ["-archs", output], root)).toBe(arch);
    }
    const object = path.join(root, `${arch}.o`);
    const archive = files[arch === "arm64" ? "armArchive" : "intelArchive"];
    runMacFixtureTool("/usr/bin/xcrun", ["clang", "-arch", arch, "-c", source, "-o", object], root);
    nativeObjects.set(arch, readFileSync(object));
    runMacFixtureTool("/usr/bin/ar", ["rcs", archive, object], root);
    expect(runMacFixtureTool("/usr/bin/lipo", ["-archs", archive], root)).toBe(arch);
  }
  runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", files.arm64, files.x86_64, "-output", files.universal],
    root,
  );
  runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", files.armLibrary, files.intelLibrary, "-output", files.universalLibrary],
    root,
  );
  runMacFixtureTool(
    "/usr/bin/xcrun",
    ["clang", "-target", "x86_64-unknown-linux-gnu", "-c", source, "-o", files.elf],
    root,
  );
  expect(runMacFixtureTool("/usr/bin/file", ["-b", files.elf], root)).toContain("ELF");
  runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", "-fat64", files.arm64, files.x86_64, "-output", files.fat64],
    root,
  );
  runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", files.armArchive, files.intelArchive, "-output", files.universalArchive],
    root,
  );
  runMacFixtureTool(
    "/usr/bin/xcrun",
    ["clang", "-target", "x86_64-pc-windows-msvc", "-c", source, "-o", files.coff],
    root,
  );
  expect(runMacFixtureTool("/usr/bin/file", ["-b", files.coff], root)).toContain("COFF");
  // Minimal inert PE32+ image: DOS header, NT/optional headers, one .text section.
  const pe = Buffer.alloc(1024);
  pe.write("MZ");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0x8664, 132);
  pe.writeUInt16LE(1, 134);
  pe.writeUInt16LE(240, 148);
  pe.writeUInt16LE(0x22, 150);
  pe.writeUInt16LE(0x20b, 152);
  pe.writeUInt32LE(4096, 168);
  pe.writeBigUInt64LE(0x140000000n, 176);
  pe.writeUInt32LE(4096, 184);
  pe.writeUInt32LE(512, 188);
  pe.writeUInt32LE(8192, 208);
  pe.writeUInt32LE(512, 212);
  pe.writeUInt16LE(3, 220);
  pe.write(".text", 392);
  pe.writeUInt32LE(1, 400);
  pe.writeUInt32LE(4096, 404);
  pe.writeUInt32LE(512, 408);
  pe.writeUInt32LE(512, 412);
  pe.writeUInt32LE(0x60000020, 428);
  pe[512] = 0xc3;
  writeFileSync(path.join(root, "windows.exe"), pe);
  expect(
    runMacFixtureTool("/usr/bin/file", ["-b", path.join(root, "windows.exe")], root),
  ).toContain("PE32+");
  nativeFixtures = {
    arm64: readFileSync(files.arm64),
    x86_64: readFileSync(files.x86_64),
    universal: readFileSync(files.universal),
    fat64: readFileSync(files.fat64),
    universalArchive: readFileSync(files.universalArchive),
    coff: readFileSync(files.coff),
    pe,
    armLibrary: readFileSync(files.armLibrary),
    intelLibrary: readFileSync(files.intelLibrary),
    universalLibrary: readFileSync(files.universalLibrary),
    elf: readFileSync(files.elf),
    armArchive: readFileSync(files.armArchive),
    intelArchive: readFileSync(files.intelArchive),
  };
  return nativeFixtures;
}
