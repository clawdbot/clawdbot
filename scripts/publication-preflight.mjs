#!/usr/bin/env node
// Opt-in local publication review gates for branch, diff, identity, privacy, and PR overlap.
// Remote branch protection and CI remain the authoritative publication controls.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_REPOSITORY = "openclaw/openclaw";
export const DEFAULT_REMOTE = "origin";
export const DEFAULT_BASE = "main";
export const MANIFEST_VERSION = 1;

const PROTECTED_BRANCHES = new Set(["main", "master", "dev"]);
const STRATEGIES = new Set(["new_independent", "update_existing", "supersede_existing"]);
const NO_REPLY_EMAIL = /^[0-9]+\+[A-Za-z0-9._-]+@users\.noreply\.github\.com$/iu;
const PUBLIC_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "users.noreply.github.com",
]);
const SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token|private[_-]?key)\b\s*[:=]\s*["']([^"'\n]{8,})/iu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const PROVIDER_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/u;
const EMAIL = /\b[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/gu;
const PRIVATE_URL = new RegExp(
  String.raw`\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[^/\s]+\.(?:local|internal))(?:[/:\s]|$)`,
  "iu",
);
const OPENCLAW_PATH_SEGMENT = "\\.openclaw";
const PRIVATE_PATH = new RegExp(
  [
    "(?:^|[\"'\\s(])/(?:home|Users|private/var)/",
    "(?:^|[\"'\\s(])[A-Za-z]:\\\\Users\\\\",
    `(?:^|["'\\s(/])${OPENCLAW_PATH_SEGMENT}(?:/|\\\\)`,
    "(?:^|[\"'\\s])(?:MEMORY|USER|SOUL)\\.md(?:$|[\"'\\s])",
  ].join("|"),
  "iu",
);

export class PublicationPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicationPreflightError";
  }
}

function fail(message) {
  throw new PublicationPreflightError(message);
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    fail(`Expected ${option} <value>.`);
  }
  return value;
}

function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+/gu, "/");
}

function parseInteger(value, option) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    fail(`${option} must be a positive integer.`);
  }
  return Number(value);
}

export function parseArgs(argv = []) {
  const args = {
    command: "check",
    manifest: null,
    repository: DEFAULT_REPOSITORY,
    remote: DEFAULT_REMOTE,
    remoteName: null,
    remoteUrl: null,
    base: DEFAULT_BASE,
    upstream: null,
    paths: [],
    privateNames: [],
    approvedEmails: [],
    strategy: "new_independent",
    existingPr: null,
    supersedesPr: null,
    supersedesReason: null,
    disposition: null,
    inventoryFile: null,
    inventoryJson: null,
    quiet: false,
  };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    args.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      args.manifest = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--repository") {
      args.repository = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--remote") {
      args.remote = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--remote-name") {
      args.remoteName = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--remote-url") {
      args.remoteUrl = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--base") {
      args.base = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--upstream") {
      args.upstream = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--path") {
      args.paths.push(normalizePath(valueAfter(argv, index, arg)));
      index += 1;
    } else if (arg === "--private-name") {
      args.privateNames.push(valueAfter(argv, index, arg));
      index += 1;
    } else if (arg === "--approved-email") {
      args.approvedEmails.push(valueAfter(argv, index, arg).toLowerCase());
      index += 1;
    } else if (arg === "--strategy") {
      args.strategy = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--existing-pr") {
      args.existingPr = parseInteger(valueAfter(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--supersedes-pr") {
      args.supersedesPr = parseInteger(valueAfter(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--supersedes-reason") {
      args.supersedesReason = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--disposition") {
      args.disposition = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--inventory-file") {
      args.inventoryFile = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--inventory-json") {
      args.inventoryJson = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      args.command = "help";
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  if (!new Set(["prepare", "check", "approve", "hook", "help"]).has(args.command)) {
    fail(`Unknown command: ${args.command}`);
  }
  if (!STRATEGIES.has(args.strategy)) {
    fail(`Unknown publication strategy: ${args.strategy}`);
  }
  return args;
}

function runGit(cwd, gitArgs, input) {
  try {
    return execFileSync("git", gitArgs, {
      cwd,
      encoding: "utf8",
      input,
      maxBuffer: 32 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    const detail = stderr ? `: ${stderr}` : "";
    return fail(`git ${gitArgs.join(" ")} failed${detail}`);
  }
}

function gitText(cwd, gitArgs) {
  return runGit(cwd, gitArgs).trim();
}

function repoRoot(cwd) {
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  try {
    return realpathSync(root);
  } catch {
    return fail("repository root cannot be resolved safely");
  }
}

function assertRepoRoot(cwd) {
  const expected = realpathSync(path.resolve(cwd));
  const actual = repoRoot(cwd);
  if (expected !== actual) {
    fail("run the publication preflight from the repository root");
  }
  return actual;
}

function canonicalRemoteUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (/^[^/@\s]+@[^:/\s]+:[^\s]+$/u.test(value)) {
    const [, host, remotePath] = value.match(/^[^/@\s]+@([^:/\s]+):(.+)$/u);
    return `https://${host}/${remotePath}`
      .replace(/\.git$/u, "")
      .replace(/\/$/u, "")
      .toLowerCase();
  }
  try {
    const url = new URL(value);
    return `https://${url.hostname}${url.pathname}`
      .replace(/\.git$/u, "")
      .replace(/\/$/u, "")
      .toLowerCase();
  } catch {
    return value
      .replace(/\.git$/u, "")
      .replace(/\/$/u, "")
      .toLowerCase();
  }
}

function remoteUrl(cwd, remote, push = true) {
  const args = ["remote", "get-url"];
  if (push) {
    args.push("--push");
  }
  args.push(remote);
  return gitText(cwd, args);
}

function currentBranch(cwd) {
  const branch = gitText(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch || PROTECTED_BRANCHES.has(branch)) {
    fail("publication requires a named feature branch, not a detached or protected branch");
  }
  if (branch.includes("/") && branch.split("/").some((part) => part === "..")) {
    fail("feature branch name is unsafe");
  }
  return branch;
}

function verifyBase(cwd, base, upstream, branch) {
  if (!base || !upstream || !upstream.endsWith(`/${base}`)) {
    fail("manifest must name an explicit base branch and matching upstream ref");
  }
  if (upstream === branch || base === branch) {
    fail("feature branch must differ from the publication base");
  }
  runGit(cwd, ["rev-parse", "--verify", `${upstream}^{commit}`]);
  if (runGit(cwd, ["merge-base", "--is-ancestor", upstream, "HEAD"], undefined) === undefined) {
    // runGit throws on a non-zero status; this branch is for type clarity only.
    fail("publication branch does not contain the declared upstream base");
  }
  const mergeCount = gitText(cwd, ["rev-list", "--count", "--merges", `${upstream}..HEAD`]);
  if (mergeCount !== "0") {
    fail("publication branch contains merge commits; rebase onto the declared upstream base");
  }
}

function stagedPaths(cwd) {
  return listPaths(runGit(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"]));
}

function rangePaths(cwd, upstream) {
  return listPaths(
    runGit(cwd, ["diff", "--name-only", "--diff-filter=ACMRD", "-z", `${upstream}..HEAD`]),
  );
}

function listPaths(raw) {
  return [...new Set(String(raw).split("\0").map(normalizePath).filter(Boolean))].toSorted();
}

function exactPathSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  const missing = expected.filter((value) => !actualSet.has(value));
  if (unexpected.length || missing.length) {
    const details = [];
    if (unexpected.length) {
      details.push(`unexpected: ${unexpected.join(", ")}`);
    }
    if (missing.length) {
      details.push(`missing: ${missing.join(", ")}`);
    }
    fail(`${label} does not match the explicit manifest allowlist (${details.join("; ")})`);
  }
}

function manifestPath(cwd, requested) {
  if (requested) {
    return path.resolve(cwd, requested);
  }
  return path.resolve(
    cwd,
    gitText(cwd, ["rev-parse", "--git-path", "publication-security-manifest.json"]),
  );
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    fail(`publication manifest is missing: ${normalizePath(filePath)}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fail("publication manifest is not valid JSON");
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("publication manifest must be a JSON object");
  }
  if (manifest.version !== MANIFEST_VERSION) {
    fail(`publication manifest version must be ${MANIFEST_VERSION}`);
  }
  if (manifest.repository !== DEFAULT_REPOSITORY) {
    fail(`publication target must be ${DEFAULT_REPOSITORY}`);
  }
  requireString(manifest.base, "manifest.base");
  requireString(manifest.upstream, "manifest.upstream");
  requireString(manifest.head, "manifest.head");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("manifest.files must be a non-empty explicit allowlist");
  }
  const normalizedFiles = manifest.files.map(normalizePath);
  if (
    normalizedFiles.some(
      (file) => !file || file.startsWith("/") || file.startsWith("../") || file.includes("/../"),
    )
  ) {
    fail("manifest.files contains an unsafe path");
  }
  if (new Set(normalizedFiles).size !== normalizedFiles.length) {
    fail("manifest.files contains duplicate paths");
  }
  if (!Array.isArray(manifest.privateNames)) {
    fail("manifest.privateNames must be present, even when empty");
  }
  if (!Array.isArray(manifest.approvedEmails) || manifest.approvedEmails.length === 0) {
    fail("manifest.approvedEmails must contain an approved GitHub no-reply identity");
  }
  for (const email of manifest.approvedEmails) {
    if (!isApprovedNoReplyEmail(email)) {
      fail("manifest.approvedEmails contains an unapproved identity");
    }
  }
  if (!manifest.remote || typeof manifest.remote !== "object") {
    fail("manifest.remote is required");
  }
  requireString(manifest.remote.name, "manifest.remote.name");
  requireString(manifest.remote.url, "manifest.remote.url");
  if (!STRATEGIES.has(manifest.strategy)) {
    fail(`manifest.strategy must be one of ${[...STRATEGIES].join(", ")}`);
  }
  if (!Array.isArray(manifest.openPrInventory)) {
    fail("manifest.openPrInventory is required; record the open-PR inventory before publishing");
  }
  if (manifest.strategy === "update_existing") {
    requirePositiveInteger(manifest.existingPr, "manifest.existingPr");
  }
  if (manifest.strategy === "supersede_existing") {
    requirePositiveInteger(manifest.supersedesPr, "manifest.supersedesPr");
    requireString(manifest.supersedesReason, "manifest.supersedesReason");
    requireString(manifest.disposition, "manifest.disposition");
  }
  if (!manifest.approval || typeof manifest.approval !== "object") {
    fail("manifest.approval is required; publication is never implicit");
  }
  return { ...manifest, files: normalizedFiles };
}

export function isApprovedNoReplyEmail(email) {
  return NO_REPLY_EMAIL.test(String(email ?? "").trim());
}

function emailIsPublicPlaceholder(email) {
  const [, domain = ""] = String(email).toLowerCase().split("@", 2);
  return PUBLIC_EMAIL_DOMAINS.has(domain);
}

export function scanSecurityText(text, { privateNames = [] } = {}) {
  const findings = [];
  const lines = String(text ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (PRIVATE_KEY_BLOCK.test(line)) {
      findings.push({ kind: "private-key", line: lineNumber });
    }
    if (SECRET_ASSIGNMENT.test(line)) {
      findings.push({ kind: "credential-assignment", line: lineNumber });
    }
    if (PROVIDER_TOKEN.test(line)) {
      findings.push({ kind: "provider-token", line: lineNumber });
    }
    if (PRIVATE_URL.test(line)) {
      findings.push({ kind: "internal-url", line: lineNumber });
    }
    if (PRIVATE_PATH.test(line)) {
      findings.push({ kind: "private-path", line: lineNumber });
    }
    for (const email of line.matchAll(EMAIL)) {
      if (!emailIsPublicPlaceholder(email[0]) && !isApprovedNoReplyEmail(email[0])) {
        findings.push({ kind: "personal-email", line: lineNumber });
      }
    }
    for (const privateName of privateNames) {
      if (
        privateName &&
        line.toLocaleLowerCase().includes(String(privateName).toLocaleLowerCase())
      ) {
        findings.push({ kind: "private-name", line: lineNumber });
      }
    }
  }
  return findings;
}

function scanDiff(cwd, diffArgs, label, privateNames) {
  const diff = runGit(cwd, diffArgs);
  const findings = scanSecurityText(diff, { privateNames });
  if (findings.length > 0) {
    const summary = [...new Set(findings.map((finding) => `${finding.kind}@${finding.line}`))].join(
      ", ",
    );
    fail(`${label} contains blocked security/privacy findings (${summary})`);
  }
}

function validateChangedFilePaths(paths) {
  const findings = paths.filter(
    (file) => PRIVATE_PATH.test(file) || /(?:^|\/)(?:\.env|.*\.(?:pem|key|p12))$/iu.test(file),
  );
  if (findings.length > 0) {
    fail(`changed paths include private or credential material (${findings.join(", ")})`);
  }
}

function validateIdentity(cwd, upstream, approvedEmails) {
  const allowed = new Set(approvedEmails.map((email) => email.toLowerCase()));
  const log = runGit(cwd, ["log", "--format=%H%x00%ae%x00%ce%x00", `${upstream}..HEAD`]);
  const fields = log.split("\0").filter(Boolean);
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [sha, author, committer] = fields.slice(index, index + 3);
    if (!isApprovedNoReplyEmail(author) || !allowed.has(author.toLowerCase())) {
      fail(`commit ${sha.slice(0, 12)} has an unapproved author identity`);
    }
    if (!isApprovedNoReplyEmail(committer) || !allowed.has(committer.toLowerCase())) {
      fail(`commit ${sha.slice(0, 12)} has an unapproved committer identity`);
    }
  }
  const configured = gitText(cwd, ["config", "--get", "user.email"]);
  if (!isApprovedNoReplyEmail(configured) || !allowed.has(configured.toLowerCase())) {
    fail("configured git user.email is not an approved GitHub no-reply identity");
  }
}

export function validateInventory(manifest, changedPaths) {
  const overlaps = [];
  for (const entry of manifest.openPrInventory) {
    if (!entry || typeof entry !== "object") {
      fail("manifest.openPrInventory contains an invalid entry");
    }
    requirePositiveInteger(entry.number, "open PR number");
    requireString(entry.repository, "open PR repository");
    requireString(entry.author, "open PR author");
    requireString(entry.branch, "open PR branch");
    requireString(entry.title, "open PR title");
    if (!Array.isArray(entry.paths)) {
      fail(`open PR #${entry.number} is missing its changed-path inventory`);
    }
    const entryPaths = new Set(entry.paths.map(normalizePath));
    const shared = changedPaths.filter((file) => entryPaths.has(file));
    const sameBranch = entry.repository === manifest.repository && entry.branch === manifest.head;
    if (shared.length || sameBranch) {
      overlaps.push({ number: entry.number, paths: shared, sameBranch });
    }
  }
  if (manifest.strategy === "new_independent" && overlaps.length > 0) {
    fail(
      `open PR overlap requires update_existing or supersede_existing (PRs: ${overlaps.map((item) => item.number).join(", ")})`,
    );
  }
  if (manifest.strategy === "update_existing") {
    const selected = overlaps.find((item) => item.number === manifest.existingPr);
    if (!selected) {
      fail(
        `manifest.existingPr #${manifest.existingPr} is not present in the overlapping open-PR inventory`,
      );
    }
    if (!selected.sameBranch) {
      fail(`manifest.existingPr #${manifest.existingPr} does not use the current feature branch`);
    }
    const undeclared = overlaps.filter((item) => item.number !== manifest.existingPr);
    if (undeclared.length > 0) {
      fail(
        `update_existing leaves undeclared overlapping PRs (${undeclared.map((item) => item.number).join(", ")})`,
      );
    }
  }
  if (manifest.strategy === "supersede_existing") {
    if (!overlaps.some((item) => item.number === manifest.supersedesPr)) {
      fail(
        `manifest.supersedesPr #${manifest.supersedesPr} is not present in the overlapping open-PR inventory`,
      );
    }
    const undeclared = overlaps.filter((item) => item.number !== manifest.supersedesPr);
    if (undeclared.length > 0) {
      fail(
        `supersede_existing leaves undeclared overlapping PRs (${undeclared.map((item) => item.number).join(", ")})`,
      );
    }
  }
}

function verifyRemote(cwd, manifest, hookArgs = {}) {
  const configuredName = hookArgs.remoteName ?? manifest.remote.name;
  if (configuredName !== manifest.remote.name) {
    fail(`push remote ${configuredName} does not match manifest remote ${manifest.remote.name}`);
  }
  const actualPushUrl = canonicalRemoteUrl(remoteUrl(cwd, configuredName, true));
  const expectedUrl = canonicalRemoteUrl(manifest.remote.url);
  if (!actualPushUrl || actualPushUrl !== expectedUrl) {
    fail("push remote URL does not match the publication manifest");
  }
  if (hookArgs.remoteUrl && canonicalRemoteUrl(hookArgs.remoteUrl) !== expectedUrl) {
    fail("pre-push remote URL does not match the publication manifest");
  }
}

function verifyPushRefs(cwd, branch, input) {
  if (input === undefined) {
    return;
  }
  if (input.trim() === "") {
    fail("pre-push input did not contain an update for the current feature branch");
  }
  const headSha = gitText(cwd, ["rev-parse", "HEAD"]);
  const lines = input.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    fail("pre-push must contain exactly one update for the current feature branch");
  }
  const [localRef, localSha, remoteRef] = lines[0].split(/\s+/u);
  const localRefMatches = localRef === "HEAD" || localRef === `refs/heads/${branch}`;
  if (!localRefMatches || localSha !== headSha || remoteRef !== `refs/heads/${branch}`) {
    fail("pre-push update is not the exact reviewed HEAD");
  }
}

function validateApproval(manifest, headSha) {
  if (manifest.approval.granted !== true) {
    fail(
      "external publication approval is required; run the explicit approve command after review",
    );
  }
  if (manifest.approval.head !== headSha) {
    fail("publication approval is not bound to the current HEAD");
  }
}

function validateCommon(cwd, manifest, options = {}) {
  assertRepoRoot(cwd);
  const branch = currentBranch(cwd);
  if (manifest.head !== branch) {
    fail(`manifest.head ${manifest.head} does not match the current branch ${branch}`);
  }
  verifyRemote(cwd, manifest, options);
  verifyBase(cwd, manifest.base, manifest.upstream, branch);
  verifyPushRefs(cwd, branch, options.pushInput);
  validateChangedFilePaths(manifest.files);
  validateInventory(manifest, manifest.files);
  validateIdentity(cwd, manifest.upstream, manifest.approvedEmails);
  runGit(cwd, ["diff", "--check", `${manifest.upstream}..HEAD`]);
  runGit(cwd, ["diff", "--cached", "--check"]);
  scanDiff(
    cwd,
    ["diff", "--no-ext-diff", "--text", `${manifest.upstream}..HEAD`],
    "commit range",
    manifest.privateNames,
  );
  scanDiff(
    cwd,
    ["diff", "--cached", "--no-ext-diff", "--text"],
    "staged diff",
    manifest.privateNames,
  );
  exactPathSet(rangePaths(cwd, manifest.upstream), manifest.files, "commit range");
  const staged = stagedPaths(cwd);
  if (staged.length > 0) {
    exactPathSet(staged, manifest.files, "staged files");
  }
  const headSha = gitText(cwd, ["rev-parse", "HEAD"]);
  if (options.requireApproval) {
    validateApproval(manifest, headSha);
  }
  return { branch, headSha, staged };
}

function readInventory(args) {
  if (args.inventoryJson) {
    return JSON.parse(args.inventoryJson);
  }
  if (args.inventoryFile) {
    return JSON.parse(readFileSync(args.inventoryFile, "utf8"));
  }
  return null;
}

function readGhPaginatedArray(exec, args, failureMessage) {
  let raw;
  try {
    raw = exec("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fail(failureMessage);
  }
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch {
    fail(failureMessage);
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    fail(failureMessage);
  }
  return pages.flat();
}

export function collectOpenPrInventory(repository, { execFileSync: exec = execFileSync } = {}) {
  const pulls = readGhPaginatedArray(
    exec,
    ["api", "--paginate", "--slurp", `repos/${repository}/pulls?state=open&per_page=100`],
    "open-PR inventory failed closed; authenticate gh or provide --inventory-file",
  );
  return pulls.map((pull) => {
    if (!Number.isInteger(pull?.number) || pull.number <= 0) {
      fail("open-PR inventory failed closed because GitHub returned an invalid pull request");
    }
    const files = readGhPaginatedArray(
      exec,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/pulls/${pull.number}/files?per_page=100`,
      ],
      `open-PR inventory failed closed while reading PR #${pull.number}`,
    );
    if (files.some((file) => typeof file?.filename !== "string" || !file.filename.trim())) {
      fail(`open-PR inventory failed closed while reading PR #${pull.number}`);
    }
    return {
      number: pull.number,
      repository,
      author: pull.user?.login ?? "unknown",
      branch: pull.head?.ref,
      title: pull.title,
      url: pull.html_url ?? null,
      paths: files.map((file) => normalizePath(file.filename)),
    };
  });
}

function prepare(cwd, args) {
  assertRepoRoot(cwd);
  const branch = currentBranch(cwd);
  const upstream = args.upstream ?? `${args.remote}/${args.base}`;
  const remotePushUrl = remoteUrl(cwd, args.remote, true);
  if (!remotePushUrl) {
    fail("publication remote URL is missing");
  }
  if (!args.paths.length) {
    fail("prepare requires one or more explicit --path allowlist entries");
  }
  const files = [...new Set(args.paths)].toSorted((left, right) => left.localeCompare(right));
  validateChangedFilePaths(files);
  verifyBase(cwd, args.base, upstream, branch);
  const staged = stagedPaths(cwd);
  exactPathSet(staged, files, "staged files");
  runGit(cwd, ["diff", "--cached", "--check"]);
  scanDiff(cwd, ["diff", "--cached", "--no-ext-diff", "--text"], "staged diff", args.privateNames);
  const configuredEmail = gitText(cwd, ["config", "--get", "user.email"]);
  const approvedEmails = [
    ...new Set(
      (args.approvedEmails.length ? args.approvedEmails : [configuredEmail]).map((email) =>
        email.toLowerCase(),
      ),
    ),
  ];
  for (const email of approvedEmails) {
    if (!isApprovedNoReplyEmail(email)) {
      fail("prepare requires an approved GitHub no-reply author/committer identity");
    }
  }
  const suppliedInventory = readInventory(args);
  const openPrInventory =
    suppliedInventory?.pullRequests ?? suppliedInventory ?? collectOpenPrInventory(args.repository);
  const manifest = {
    version: MANIFEST_VERSION,
    repository: args.repository,
    remote: { name: args.remote, url: remotePushUrl },
    base: args.base,
    upstream,
    head: branch,
    files,
    privateNames: [...new Set(args.privateNames)],
    approvedEmails,
    strategy: args.strategy,
    existingPr: args.existingPr,
    supersedesPr: args.supersedesPr,
    supersedesReason: args.supersedesReason,
    disposition: args.disposition,
    openPrInventory,
    approval: { granted: false, head: null, approvedAt: null },
  };
  validateManifestShape(manifest);
  validateInventory(manifest, files);
  writeJson(manifestPath(cwd, args.manifest), manifest);
  return `prepared ${files.length} allowlisted file(s); approval remains required`;
}

function approve(cwd, args) {
  const filePath = manifestPath(cwd, args.manifest);
  const manifest = validateManifestShape(readJson(filePath));
  const result = validateCommon(cwd, manifest, { requireApproval: false });
  manifest.approval = {
    granted: true,
    head: result.headSha,
    approvedAt: new Date().toISOString(),
  };
  writeJson(filePath, manifest);
  return `approved exact HEAD ${result.headSha}`;
}

function check(cwd, args, options = {}) {
  const manifest = validateManifestShape(readJson(manifestPath(cwd, args.manifest)));
  const result = validateCommon(cwd, manifest, options);
  return `ok ${result.branch} @ ${result.headSha}`;
}

function help() {
  return [
    "Usage:",
    "  node scripts/publication-preflight.mjs prepare --path <file>... [options]",
    "  node scripts/publication-preflight.mjs check [options]",
    "  node scripts/publication-preflight.mjs approve [options]",
    "  node scripts/publication-preflight.mjs hook --remote-name <name> --remote-url <url> [options]",
    "",
    "prepare records an explicit staged-file allowlist and open-PR inventory in a per-worktree Git manifest.",
    "approve is a separate human action; hook requires approval bound to the exact HEAD being pushed.",
    "This helper is a local review gate only; it cannot enforce remote publication security.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), stdin } = {}) {
  const args = parseArgs(argv);
  if (args.command === "help") {
    console.log(help());
    return;
  }
  const message =
    args.command === "prepare"
      ? prepare(cwd, args)
      : args.command === "approve"
        ? approve(cwd, args)
        : check(cwd, args, {
            requireApproval: args.command === "hook",
            remoteName: args.remoteName,
            remoteUrl: args.remoteUrl,
            pushInput: args.command === "hook" ? stdin : undefined,
          });
  if (!args.quiet) {
    console.error(`[publication-preflight] ${message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main(process.argv.slice(2), {
      stdin: (() => {
        try {
          return readFileSync(0, "utf8");
        } catch {
          return "";
        }
      })(),
    });
  } catch (error) {
    console.error(
      `[publication-preflight] blocked: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
