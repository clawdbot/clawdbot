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
  // Match published machine addresses, never names or provider domains that
  // can also identify human contributors.
  return /^Co-authored-by:\s*[^<>]+<(?:noreply@anthropic\.com|cursoragent@cursor\.com|amp@ampcode\.com)>$/i.test(
    line,
  );
}

function coauthorEmail(line) {
  const match = /^Co-authored-by:\s*[^<>]+<([^<>\r\n]+)>$/i.exec(line);
  if (!match) {
    throw new Error(`Cannot validate squash preview co-author: ${JSON.stringify(line)}.`);
  }
  return match[1].trim().toLowerCase();
}

function removeUnsupportedPreviewCredit(preview, unsupported) {
  if (unsupported.length === 0) {
    return preview;
  }
  const lines = preview.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const counts = new Map();
  for (const credit of unsupported) {
    const normalized = credit.toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  for (const [expected, count] of counts) {
    const matches = lines.flatMap((line, index) => {
      const text = line.replace(/\r?\n$/, "");
      return text.toLowerCase() === expected ? [index] : [];
    });
    if (matches.length !== count) {
      throw new Error("Cannot remove unsupported squash preview credit unambiguously.");
    }
    for (const index of matches) {
      lines[index] = "";
    }
  }
  let body = lines.join("");
  if (trailers(body).length === 0) {
    body = body.replace(/\r?\n\r?\n---------\r?\n(?:[ \t]*\r?\n)*$/, "");
  }
  return body;
}

function compose({ preview, source, authors, captured, queue }) {
  const explicit = captured !== "";
  const sourceTrailers = source.split("\n").filter(Boolean);
  const eligibleEmails = new Set(
    authors
      .split("\n")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const line of sourceTrailers) {
    if (/^Co-authored-by:/i.test(line) && !isMachineCredit(line)) {
      eligibleEmails.add(coauthorEmail(line));
    }
  }
  const previewTrailers = trailers(preview);
  const previewCredits = previewTrailers.filter((line) => /^Co-authored-by:/i.test(line));
  const unsupportedPreviewCredits = previewCredits.filter(
    (line) => !isMachineCredit(line) && !eligibleEmails.has(coauthorEmail(line)),
  );
  const retainedPreviewCredits = previewCredits.filter(
    (line) => !isMachineCredit(line) && eligibleEmails.has(coauthorEmail(line)),
  );
  if (queue && unsupportedPreviewCredits.length > 0) {
    throw new Error("Cannot queue a squash message with unsupported preview co-author credit.");
  }
  let body = explicit
    ? Buffer.from(JSON.parse(captured).base64, "base64").toString("utf8")
    : removeUnsupportedPreviewCredit(preview, unsupportedPreviewCredits);
  const original = trailers(body);
  if (original.some(isMachineCredit)) {
    throw new Error(
      "Squash message contains machine co-author credit; use --body-file with a reviewed message preserving human contributors.",
    );
  }
  const required = [
    ...original,
    ...(explicit ? retainedPreviewCredits : []),
    ...sourceTrailers,
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
  const excludedEmails = new Set(unsupportedPreviewCredits.map(coauthorEmail));
  if (
    !explicit &&
    final.some((line) => /^Co-authored-by:/i.test(line) && excludedEmails.has(coauthorEmail(line)))
  ) {
    throw new Error("Cannot remove unsupported squash preview credit.");
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
