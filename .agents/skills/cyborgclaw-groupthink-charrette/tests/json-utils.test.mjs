import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_JSON_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  canonicalJson,
  decodeUtf8Strict,
  parseJsonStrict,
  readJsonStrict,
} from "../scripts/json-utils.mjs";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "charrette-json-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("strict UTF-8 decoding rejects malformed byte sequences", () => {
  assert.throws(
    () => decodeUtf8Strict(Uint8Array.from([0xc3, 0x28]), "malformed.json"),
    (error) => error.code === "INVALID_JSON" && /malformed UTF-8/.test(error.message),
  );
});

test("strict JSON parsing rejects precision-losing and noncanonical numbers", () => {
  for (const input of ["9007199254740992", "1.0", "1e0", "-0"]) {
    assert.throws(
      () => parseJsonStrict(input, "number.json"),
      (error) =>
        error.code === "INVALID_JSON" &&
        /non-canonical or precision-losing number/.test(error.message),
    );
  }
});

test("strict JSON parsing rejects escaped lone surrogates in values and keys", () => {
  for (const input of [
    '{"value":"\\ud800"}',
    '{"value":"\\udc00"}',
    '{"\\ud800":"value"}',
    '{"\\udc00":"value"}',
  ]) {
    assert.throws(
      () => parseJsonStrict(input, "surrogate.json"),
      (error) => error.code === "INVALID_JSON",
    );
  }
});

test("canonical JSON rejects programmatic lone surrogates", () => {
  for (const value of ["\ud800", "\udc00", { ["\ud800"]: "value" }, { ["\udc00"]: "value" }]) {
    assert.throws(
      () => canonicalJson(value),
      (error) => error.code === "INVALID_JSON" && /unpaired UTF-16 surrogate/.test(error.message),
    );
  }
});

test("strict and canonical JSON preserve well-formed surrogate pairs", () => {
  const parsed = parseJsonStrict('{"\\ud83d\\ude80":"\\ud83d\\ude80"}', "emoji.json");
  assert.equal(parsed["🚀"], "🚀");
  assert.equal(canonicalJson(parsed), '{"🚀":"🚀"}');
});

test("strict JSON parsing enforces its nesting-depth limit", () => {
  const depth = MAX_JSON_DEPTH + 2;
  const input = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  assert.throws(
    () => parseJsonStrict(input, "deep.json"),
    (error) => error.code === "INVALID_JSON" && /maximum nesting depth/.test(error.message),
  );
});

test("strict JSON parsing enforces its byte-size limit", () => {
  const input = `{"payload":"${"a".repeat(MAX_JSON_BYTES)}"}`;
  assert.throws(
    () => parseJsonStrict(input, "large.json"),
    (error) => error.code === "INVALID_JSON" && /byte limit/.test(error.message),
  );
});

test("strict JSON parsing enforces its node-count limit", () => {
  const input = `[${"0,".repeat(MAX_JSON_NODES)}0]`;
  assert.throws(
    () => parseJsonStrict(input, "wide.json"),
    (error) => error.code === "INVALID_JSON" && /maximum node count/.test(error.message),
  );
});

test("strict file reads reject FIFOs without blocking", async (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is not available on Windows");
    return;
  }
  const directory = await temporaryDirectory(t);
  const fifo = join(directory, "input.fifo");
  const createFifo = spawn("mkfifo", [fifo], { stdio: "ignore" });
  const createResult = await new Promise((resolve, reject) => {
    createFifo.once("error", reject);
    createFifo.once("close", (code) => resolve(code));
  }).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (createResult === null) {
    t.skip("mkfifo executable is unavailable");
    return;
  }
  assert.equal(createResult, 0);

  const moduleUrl = new URL("../scripts/json-utils.mjs", import.meta.url).href;
  const script = [
    `import { readJsonStrict } from ${JSON.stringify(moduleUrl)};`,
    "try {",
    "  await readJsonStrict(process.argv[1]);",
    '  console.error("unexpected success");',
    "  process.exitCode = 2;",
    "} catch (error) {",
    "  console.error(`${error.code}:${error.message}`);",
    "  process.exitCode = 7;",
    "}",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, fifo], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 2_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  clearTimeout(timer);

  assert.equal(timedOut, false, "FIFO read blocked instead of failing closed");
  assert.equal(exitCode, 7);
  assert.match(stderr, /INVALID_JSON:.*regular file/);
});

test("strict file reads reject symlinks with no-follow semantics", async (t) => {
  if (fsConstants.O_NOFOLLOW === undefined) {
    t.skip("O_NOFOLLOW is unavailable on this platform");
    return;
  }
  const directory = await temporaryDirectory(t);
  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  await writeFile(target, "{}");
  try {
    await symlink(target, link);
  } catch (error) {
    if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
      t.skip(`symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => readJsonStrict(link),
    (error) => error.code === "INVALID_JSON" && /unsafe JSON input/.test(error.message),
  );
});

test("strict file reads reject regular files larger than the byte limit", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "oversize.json");
  await writeFile(path, Buffer.alloc(MAX_JSON_BYTES + 1, 0x20));
  await assert.rejects(
    () => readJsonStrict(path),
    (error) => error.code === "INVALID_JSON" && /byte limit/.test(error.message),
  );
});
