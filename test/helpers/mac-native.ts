import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// SDK mach-o/{loader,fat}.h layouts; classification uses the host's real tools.
export function machoFixture(bits = 64, little = true, fat = false, fileType = 2): Buffer {
  const thin = Buffer.alloc(32);
  const write = (buffer: Buffer, value: number, offset: number) =>
    little ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  write(thin, bits === 64 ? 0xfeedfacf : 0xfeedface, 0);
  write(thin, bits === 64 ? 0x0100000c : 7, 4);
  write(thin, fileType, 12);
  if (!fat) {
    return thin;
  }
  const result = Buffer.alloc(4096 + thin.length);
  write(result, bits === 64 ? 0xcafebabf : 0xcafebabe, 0);
  write(result, 1, 4);
  write(result, bits === 64 ? 0x0100000c : 7, 8);
  if (bits === 64) {
    if (little) {
      result.writeBigUInt64LE(4096n, 16);
      result.writeBigUInt64LE(BigInt(thin.length), 24);
    } else {
      result.writeBigUInt64BE(4096n, 16);
      result.writeBigUInt64BE(BigInt(thin.length), 24);
    }
    write(result, 12, 32);
  } else {
    write(result, 4096, 16);
    write(result, thin.length, 20);
    write(result, 12, 24);
  }
  thin.copy(result, 4096);
  return result;
}

function runNativeFixtureTool(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(`Could not create native fixture with ${command}: ${result.stderr}`);
  }
}

function writeNativeObject(filename: string, arch: string) {
  runNativeFixtureTool(
    "/usr/bin/xcrun",
    ["clang", "-arch", arch, "-x", "c", "-c", "-", "-o", filename],
    "int native_fixture(void) { return 0; }\n",
  );
}

export function nativeObjectFixture(root: string, format: "thin" | "fat32" | "fat64"): Buffer {
  mkdirSync(root);
  const inputs = (format === "thin" ? ["arm64"] : ["arm64", "x86_64"]).map((arch) => {
    const filename = path.join(root, `${arch}.o`);
    writeNativeObject(filename, arch);
    return filename;
  });
  if (format === "thin") {
    return readFileSync(path.join(root, "arm64.o"));
  }
  const filename = path.join(root, "object");
  runNativeFixtureTool("/usr/bin/lipo", [
    "-create",
    ...(format === "fat64" ? ["-fat64"] : []),
    ...inputs,
    "-output",
    filename,
  ]);
  return readFileSync(filename);
}

export function writeFat64Fixture(filename: string): Buffer {
  runNativeFixtureTool("/usr/bin/lipo", [
    "-create",
    "-fat64",
    "/usr/bin/true",
    "-output",
    filename,
  ]);
  return readFileSync(filename);
}

export function universalArchiveFixture(root: string, fat64: boolean, mixed: boolean): Buffer {
  mkdirSync(root);
  const inputs: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const object = path.join(root, `${arch}.o`);
    if (mixed && arch === "x86_64") {
      runNativeFixtureTool("/usr/bin/lipo", ["-thin", arch, "/usr/bin/true", "-output", object]);
      inputs.push(object);
      continue;
    }
    writeNativeObject(object, arch);
    const archive = path.join(root, `${arch}.a`);
    runNativeFixtureTool("/usr/bin/ar", ["rcs", archive, object]);
    inputs.push(archive);
  }
  const filename = path.join(root, "universal");
  runNativeFixtureTool("/usr/bin/lipo", [
    "-create",
    ...(fat64 ? ["-fat64"] : []),
    ...inputs,
    "-output",
    filename,
  ]);
  return readFileSync(filename);
}
