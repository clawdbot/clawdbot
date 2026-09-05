import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

function snapshot(path) {
  const named = lstatSync(path, { bigint: true });
  if (!named.isFile()) {
    throw new Error("Merge body must be a regular file, not a symlink.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || named.dev !== before.dev || named.ino !== before.ino) {
      throw new Error("Merge body must be a regular file.");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((key) => before[key] !== after[key])) {
      throw new Error("Merge body changed while reading; retry with a stable file.");
    }
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.includes(0)) {
      throw new Error("Merge body must not contain NUL bytes.");
    }
    return {
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

function trailers(body) {
  // Parse only: mutating interpret-trailers can execute configured commands.
  const parsed = spawnSync(
    "git",
    [
      "-c",
      "trailer.separators=:",
      "-c",
      "trailer.co-authored-by.key=Co-authored-by",
      "interpret-trailers",
      "--parse",
      "--no-divider",
    ],
    {
      input: `OpenClaw merge message\n\n${body}`,
      encoding: "utf8",
    },
  );
  if (parsed.error || parsed.status !== 0) {
    throw new Error("Cannot parse squash message trailers.");
  }
  return parsed.stdout.split("\n").filter(Boolean);
}

function isMachineCredit(line) {
  // Claude Code documents this exact machine address. Names and provider domains
  // can identify human contributors, so neither is a safe exclusion rule.
  return /^Co-authored-by:\s*[^<>]+<noreply@anthropic\.com>$/i.test(line);
}

function compose({ preview, source, captured }) {
  const explicit = captured !== "";
  let body = explicit
    ? Buffer.from(JSON.parse(captured).base64, "base64").toString("utf8")
    : preview;
  const original = trailers(body);
  if (original.some(isMachineCredit)) {
    throw new Error(
      "Squash message contains machine co-author credit; use --body-file with a reviewed message preserving human contributors.",
    );
  }
  const required = [
    ...original,
    ...(explicit ? trailers(preview).filter((line) => /^Co-authored-by:/i.test(line)) : []),
    ...source.split("\n").filter(Boolean),
  ].filter((line) => !isMachineCredit(line));
  const missing = [...new Set(required)].filter((line) => !original.includes(line));
  // Keep explicit bytes, including CRLF and trailing blank lines. Insert new
  // credit before that suffix so all parsed trailers remain one terminal block.
  const suffix = explicit ? (body.match(/(?:\r?\n[ \t]*)+$/)?.[0] ?? "") : "\n";
  if (explicit && missing.length === 0) {
    return body;
  }
  body = explicit
    ? body.slice(0, body.length - suffix.length)
    : body.replace(/\n(?:[ \t\r]*\n)*[ \t\r]*$/, "");
  if (missing.length > 0) {
    body += (body ? (original.length ? "\n" : "\n\n") : "") + missing.join("\n");
  }
  body += suffix;
  const final = trailers(body);
  if (required.some((line) => !final.includes(line))) {
    throw new Error(
      "Cannot preserve squash credit: the final message lost a source or preview trailer.",
    );
  }
  return body;
}

try {
  if (process.argv[2] === "read") {
    process.stdout.write(JSON.stringify(snapshot(process.argv[3])));
  } else if (process.argv[2] === "compose") {
    process.stdout.write(compose(JSON.parse(readFileSync(0, "utf8"))));
  } else {
    throw new Error("Expected read or compose.");
  }
} catch (error) {
  console.error(`Cannot prepare merge body: ${error.message}`);
  process.exitCode = 1;
}
