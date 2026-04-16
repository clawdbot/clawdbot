import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApiContributor, Entry, MapConfig, User } from "./update-clawtributors.types.js";

const REPO = "openclaw/openclaw";
const PER_LINE = 10;
const AVATAR_PROBE_SIZE = 40;
const AVATAR_SIZE = 48;
const CLAWTRIBUTORS_START = "<!-- clawtributors:start -->";
const CLAWTRIBUTORS_END = "<!-- clawtributors:end -->";
const CLAWTRIBUTORS_HIDDEN_START = "<!-- clawtributors:hidden:start";
const CLAWTRIBUTORS_HIDDEN_END = "clawtributors:hidden:end -->";

const mapPath = resolve("scripts/clawtributors-map.json");
const mapConfig = JSON.parse(readFileSync(mapPath, "utf8")) as MapConfig;

const displayName = mapConfig.displayName ?? {};
const nameToLogin = normalizeMap(mapConfig.nameToLogin ?? {});
const emailToLogin = normalizeMap(mapConfig.emailToLogin ?? {});
const ensureLogins = (mapConfig.ensureLogins ?? []).map((login) => login.toLowerCase());

const readmePath = resolve("README.md");
const seedCommit = mapConfig.seedCommit ?? null;
const seedEntries = seedCommit ? parseReadmeEntries(run(`git show ${seedCommit}:README.md`)) : [];
const currentReadme = readFileSync(readmePath, "utf8");
const hiddenReadmeLogins = new Set(parseHiddenReadmeLogins(currentReadme));
const raw = run(`gh api "repos/${REPO}/contributors?per_page=100&anon=1" --paginate`);
const contributors = parsePaginatedJson(raw) as ApiContributor[];
const apiByLogin = new Map<string, User>();
const contributionsByLogin = new Map<string, number>();
const defaultAvatarByLogin = new Map<string, Promise<boolean>>();

for (const item of contributors) {
  if (!item?.login || !item?.html_url || !item?.avatar_url) {
    continue;
  }
  if (typeof item.contributions === "number") {
    contributionsByLogin.set(item.login.toLowerCase(), item.contributions);
  }
  apiByLogin.set(item.login.toLowerCase(), {
    login: item.login,
    html_url: item.html_url,
    avatar_url: normalizeAvatar(item.avatar_url),
  });
}

for (const login of ensureLogins) {
  if (!apiByLogin.has(login)) {
    const user = fetchUser(login);
    if (user) {
      apiByLogin.set(user.login.toLowerCase(), user);
    }
  }
}

const linesByLogin = new Map<string, number>();
const firstCommitByLogin = new Map<string, string>();

// %x1f = unit separator to avoid collisions with author names containing "|"
const log = run("git log --reverse --format=%aN%x1f%aE%x1f%aI --numstat");

let currentName: string | null = null;
let currentEmail: string | null = null;

for (const line of log.split("\n")) {
  if (!line.trim()) {
    continue;
  }

  if (line.includes("\x1f") && !/^[0-9-]/.test(line)) {
    const [name, email, date] = line.split("\x1f", 3);
    currentName = name?.trim() ?? null;
    currentEmail = email?.trim().toLowerCase() ?? null;

    // Track first commit date per login (log is --reverse so first seen = earliest)
    if (currentName && date) {
      const login = resolveLogin(currentName, currentEmail, apiByLogin, nameToLogin, emailToLogin);
      if (login) {
        const key = login.toLowerCase();
        if (!firstCommitByLogin.has(key)) {
          firstCommitByLogin.set(key, date.slice(0, 10));
        }
      }
    }
    continue;
  }

  if (!currentName) {
    continue;
  }

  const parts = line.split("\t");
  if (parts.length < 3) {
    continue;
  }

  // Skip docs paths so bulk-generated i18n scaffolds don't inflate rankings
  const filePath = parts[2];
  if (filePath.startsWith("docs/")) {
    continue;
  }

  const adds = parseCount(parts[0]);
  const dels = parseCount(parts[1]);
  const total = adds + dels;
  if (!total) {
    continue;
  }

  let login = resolveLogin(currentName, currentEmail, apiByLogin, nameToLogin, emailToLogin);
  if (!login) {
    continue;
  }

  const key = login.toLowerCase();
  linesByLogin.set(key, (linesByLogin.get(key) ?? 0) + total);
}

for (const login of ensureLogins) {
  if (!linesByLogin.has(login)) {
    linesByLogin.set(login, 0);
  }
}

const prsByLogin = new Map<string, number>();
const prRaw = run(
  `gh pr list -R ${REPO} --state merged --limit 5000 --json author --jq '.[].author.login'`,
);
for (const login of prRaw.split("\n")) {
  const trimmed = login.trim().toLowerCase();
  if (!trimmed) {
    continue;
  }
  prsByLogin.set(trimmed, (prsByLogin.get(trimmed) ?? 0) + 1);
}

// Repo epoch for tenure calculation (root commit date)
const rootCommit = run("git rev-list --max-parents=0 HEAD").split("\n")[0];
const repoEpochStr = run(`git log --format=%aI -1 ${rootCommit}`);
const repoEpoch = new Date(repoEpochStr.slice(0, 10)).getTime();
const nowDate = new Date().toISOString().slice(0, 10);
const now = new Date(nowDate).getTime();
const repoAgeDays = Math.max(1, (now - repoEpoch) / 86_400_000);

// Composite score:
//   base  = commits*2 + merged_PRs*10 + sqrt(code_LOC)
//   tenure = 1.0 + (days_since_first_commit / repo_age)^2 * 0.5
//   score  = base * tenure
// Squared curve: only true early contributors get meaningful boost.
// Day-1 = 1.5x, halfway through repo life = 1.125x, recent = ~1.0x.
function computeScore(loc: number, commits: number, prs: number, firstDate: string): number {
  const base = commits * 2 + prs * 10 + Math.sqrt(loc);
  const daysIn = firstDate
    ? Math.max(0, (now - new Date(firstDate.slice(0, 10)).getTime()) / 86_400_000)
    : 0;
  const tenureRatio = Math.min(1, daysIn / repoAgeDays);
  const tenure = 1.0 + tenureRatio * tenureRatio * 0.5;
  return base * tenure;
}

const entriesByKey = new Map<string, Entry>();

for (const seed of seedEntries) {
  const login =
    loginFromUrl(seed.html_url) ??
    resolveLogin(seed.display, null, apiByLogin, nameToLogin, emailToLogin);
  if (!login) {
    continue;
  }
  const key = login.toLowerCase();
  const user = apiByLogin.get(key) ?? fetchUser(login);
  if (!user) {
    continue;
  }
  apiByLogin.set(key, user);
  const existing = entriesByKey.get(key);
  if (!existing) {
    const fd = firstCommitByLogin.get(key) ?? "";
    entriesByKey.set(key, {
      key,
      login: user.login,
      display: seed.display,
      html_url: user.html_url,
      avatar_url: user.avatar_url,
      lines: 0,
      commits: 0,
      prs: 0,
      score: 0,
      firstCommitDate: fd,
    });
  } else {
    existing.display = existing.display || seed.display;
    existing.login = user.login;
    existing.html_url = user.html_url;
    existing.avatar_url = user.avatar_url;
  }
}

for (const item of contributors) {
  const baseName = item.name?.trim() || item.email?.trim() || item.login?.trim();
  if (!baseName) {
    continue;
  }

  const resolvedLogin = item.login
    ? item.login
    : resolveLogin(baseName, item.email ?? null, apiByLogin, nameToLogin, emailToLogin);

  if (!resolvedLogin) {
    continue;
  }

  const key = resolvedLogin.toLowerCase();
  const user = apiByLogin.get(key) ?? fetchUser(resolvedLogin);
  if (!user) {
    continue;
  }
  apiByLogin.set(key, user);

  const existing = entriesByKey.get(key);
  if (!existing) {
    const loc = linesByLogin.get(key) ?? 0;
    const commits = contributionsByLogin.get(key) ?? 0;
    const prs = prsByLogin.get(key) ?? 0;
    const fd = firstCommitByLogin.get(key) ?? "";
    entriesByKey.set(key, {
      key,
      login: user.login,
      display: pickDisplay(baseName, user.login),
      html_url: user.html_url,
      avatar_url: normalizeAvatar(user.avatar_url),
      lines: loc > 0 ? loc : commits,
      commits,
      prs,
      score: computeScore(loc, commits, prs, fd),
      firstCommitDate: fd,
    });
  } else {
    existing.login = user.login;
    existing.display = pickDisplay(baseName, user.login, existing.display);
    existing.html_url = user.html_url;
    existing.avatar_url = normalizeAvatar(user.avatar_url);
    const loc = linesByLogin.get(key) ?? 0;
    const commits = contributionsByLogin.get(key) ?? 0;
    const prs = prsByLogin.get(key) ?? 0;
    const fd = firstCommitByLogin.get(key) ?? existing.firstCommitDate;
    existing.lines = Math.max(existing.lines, loc > 0 ? loc : commits);
    existing.commits = Math.max(existing.commits, commits);
    existing.prs = Math.max(existing.prs, prs);
    existing.firstCommitDate = fd || existing.firstCommitDate;
    existing.score = Math.max(existing.score, computeScore(loc, commits, prs, fd));
  }
}

for (const [login, loc] of linesByLogin.entries()) {
  if (entriesByKey.has(login)) {
    continue;
  }
  let user = apiByLogin.get(login);
  if (!user) {
    user = fetchUser(login) || undefined;
  }
  if (user) {
    const commits = contributionsByLogin.get(login) ?? 0;
    const prs = prsByLogin.get(login) ?? 0;
    const fd = firstCommitByLogin.get(login) ?? "";
    entriesByKey.set(login, {
      key: login,
      login: user.login,
      display: displayName[user.login.toLowerCase()] ?? user.login,
      html_url: user.html_url,
      avatar_url: normalizeAvatar(user.avatar_url),
      lines: loc > 0 ? loc : commits,
      commits,
      prs,
      score: computeScore(loc, commits, prs, fd),
      firstCommitDate: fd,
    });
  }
}

const entries = Array.from(entriesByKey.values());
const visibleEntries = await filterVisibleEntries(entries, hiddenReadmeLogins);

visibleEntries.sort((a, b) => {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.display.localeCompare(b.display);
});

const markdownLines: string[] = [];
for (let i = 0; i < visibleEntries.length; i += PER_LINE) {
  const chunk = visibleEntries.slice(i, i + PER_LINE);
  const parts = chunk.map((entry) => {
    return `[![${escapeMarkdownLabel(entry.display)}](${entry.avatar_url})](${entry.html_url})`;
  });
  markdownLines.push(parts.join(" "));
}

const block = `${CLAWTRIBUTORS_START}\n${markdownLines.join("\n\n")}\n${CLAWTRIBUTORS_END}`;
const hiddenBlock = buildHiddenReadmeBlock(entries, visibleEntries);
const hiddenRange = findHiddenReadmeRange(currentReadme);
const readmeWithoutMeta = hiddenRange
  ? `${currentReadme.slice(0, hiddenRange.start)}${currentReadme.slice(hiddenRange.end)}`
  : currentReadme;
const range = findClawtributorsRange(readmeWithoutMeta);

if (!range) {
  throw new Error("README.md missing clawtributors block");
}

const next = `${readmeWithoutMeta.slice(0, range.start)}${block}\n${hiddenBlock}${readmeWithoutMeta.slice(range.end)}`;
writeFileSync(readmePath, next);

console.log(
  `Updated README clawtributors: ${visibleEntries.length} visible (${entries.length - visibleEntries.length} default-avatar entries hidden)`,
);
console.log(`\nTop 25 by composite score: (commits*2 + PRs*10 + sqrt(LOC)) * tenure`);
console.log(`  tenure = 1.0 + (days_since_first_commit / repo_age)^2 * 0.5`);
console.log(
  `${"#".padStart(3)}  ${"login".padEnd(24)} ${"score".padStart(8)} ${"tenure".padStart(7)} ${"commits".padStart(8)} ${"PRs".padStart(6)} ${"LOC".padStart(10)}  first commit`,
);
console.log("-".repeat(85));
for (const [index, entry] of visibleEntries.slice(0, 25).entries()) {
  const login = (entry.login ?? entry.key).slice(0, 24);
  const fd = entry.firstCommitDate || "?";
  const daysIn =
    fd !== "?" ? Math.max(0, (now - new Date(fd.slice(0, 10)).getTime()) / 86_400_000) : 0;
  const tr = Math.min(1, daysIn / repoAgeDays);
  const tenure = 1.0 + tr * tr * 0.5;
  console.log(
    `${index + 1}`.padStart(3) +
      `  ${login.padEnd(24)} ${entry.score.toFixed(0).padStart(8)} ${tenure.toFixed(2).padStart(6)}x ${String(entry.commits).padStart(8)} ${String(entry.prs).padStart(6)} ${String(entry.lines).padStart(10)}  ${fd}`,
  );
}

function run(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 200,
  }).trim();
}

function parsePaginatedJson(raw: string): unknown[] {
  const items: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed)) {
      items.push(...parsed);
    } else {
      items.push(parsed);
    }
  }
  return items;
}

function normalizeMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    out[normalizeName(key)] = value;
  }
  return out;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseCount(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : 0;
}

function isValidLogin(login: string): boolean {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    return false;
  }
  if (login.startsWith("-") || login.endsWith("-")) {
    return false;
  }
  if (login.includes("--")) {
    return false;
  }
  return true;
}

function normalizeLogin(login: string | null): string | null {
  if (!login) {
    return null;
  }
  const trimmed = login.trim();
  return isValidLogin(trimmed) ? trimmed : null;
}

function normalizeAvatar(url: string): string {
  if (!/^https?:/i.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("s");
    parsed.searchParams.delete("size");
    parsed.searchParams.set("s", String(AVATAR_SIZE));
    return parsed.toString();
  } catch {
    return url;
  }
}

function fetchUser(login: string): User | null {
  const normalized = normalizeLogin(login);
  if (!normalized) {
    return null;
  }
  try {
    const data = execFileSync("gh", ["api", `users/${normalized}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(data);
    if (!parsed?.login || !parsed?.html_url || !parsed?.avatar_url) {
      return null;
    }
    return {
      login: parsed.login,
      html_url: parsed.html_url,
      avatar_url: normalizeAvatar(parsed.avatar_url),
    };
  } catch {
    return null;
  }
}

function isDefaultGitHubAvatar(login: string): Promise<boolean> {
  const normalized = normalizeLogin(login)?.toLowerCase();
  if (!normalized) {
    return Promise.resolve(false);
  }
  const cached = defaultAvatarByLogin.get(normalized);
  if (cached) {
    return cached;
  }
  const pending = probeDefaultGitHubAvatar(normalized);
  defaultAvatarByLogin.set(normalized, pending);
  return pending;
}

async function probeDefaultGitHubAvatar(login: string): Promise<boolean> {
  try {
    const response = await fetch(`https://github.com/${login}.png?size=${AVATAR_PROBE_SIZE}`, {
      headers: { "user-agent": "openclaw-clawtributors" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return false;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const dimensions = readImageDimensions(buffer);
    return Boolean(
      dimensions && (dimensions.width > AVATAR_PROBE_SIZE || dimensions.height > AVATAR_PROBE_SIZE),
    );
  } catch {
    return false;
  }
}

async function filterVisibleEntries(
  entries: Entry[],
  hiddenLogins: ReadonlySet<string>,
): Promise<Entry[]> {
  const results = await mapConcurrent(entries, 8, async (entry) => {
    const login = entry.login ?? entry.key;
    if (!login) {
      return entry;
    }
    const normalized = normalizeLogin(login)?.toLowerCase();
    if (normalized && hiddenLogins.has(normalized)) {
      return null;
    }
    return (await isDefaultGitHubAvatar(login)) ? null : entry;
  });
  return results.filter((entry): entry is Entry => entry !== null);
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (isPng(buffer)) {
    return readPngDimensions(buffer);
  }
  if (isJpeg(buffer)) {
    return readJpegDimensions(buffer);
  }
  return null;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > buffer.length) {
      return null;
    }

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      return null;
    }

    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) {
        return null;
      }
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += length;
  }
  return null;
}

function resolveLogin(
  name: string,
  email: string | null,
  apiByLogin: Map<string, User>,
  nameToLogin: Record<string, string>,
  emailToLogin: Record<string, string>,
): string | null {
  if (email && emailToLogin[email]) {
    return normalizeLogin(emailToLogin[email]);
  }

  if (email && name) {
    const guessed = guessLoginFromEmailName(name, email, apiByLogin);
    if (guessed) {
      return normalizeLogin(guessed);
    }
  }

  if (email && email.endsWith("@users.noreply.github.com")) {
    const local = email.split("@", 1)[0];
    const login = local.includes("+") ? local.split("+")[1] : local;
    return normalizeLogin(login);
  }

  if (email && email.endsWith("@github.com")) {
    const login = email.split("@", 1)[0];
    if (apiByLogin.has(login.toLowerCase())) {
      return normalizeLogin(login);
    }
  }

  const normalized = normalizeName(name);
  if (nameToLogin[normalized]) {
    return normalizeLogin(nameToLogin[normalized]);
  }

  const compact = normalized.replace(/\s+/g, "");
  if (nameToLogin[compact]) {
    return normalizeLogin(nameToLogin[compact]);
  }

  if (apiByLogin.has(normalized)) {
    return normalizeLogin(normalized);
  }

  if (apiByLogin.has(compact)) {
    return normalizeLogin(compact);
  }

  return null;
}

function guessLoginFromEmailName(
  name: string,
  email: string,
  apiByLogin: Map<string, User>,
): string | null {
  const local = email.split("@", 1)[0]?.trim();
  if (!local) {
    return null;
  }
  const normalizedName = normalizeIdentifier(name);
  if (!normalizedName) {
    return null;
  }
  const candidates = new Set([local, local.replace(/[._-]/g, "")]);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (normalizeIdentifier(candidate) !== normalizedName) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (apiByLogin.has(key)) {
      return key;
    }
  }
  return null;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function parseReadmeEntries(
  content: string,
): Array<{ display: string; html_url: string; avatar_url: string }> {
  const range = findClawtributorsRange(content);
  if (!range) {
    return [];
  }
  const block = content.slice(range.start, range.end);
  const entries: Array<{ display: string; html_url: string; avatar_url: string }> = [];
  const markdown = /\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/g;
  for (const match of block.matchAll(markdown)) {
    const [, alt, src, href] = match;
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({ html_url: href, avatar_url: src, display: alt.replace(/\\([\\[\]])/g, "$1") });
  }
  const linked = /<a href="([^"]+)"><img src="([^"]+)"[^>]*alt="([^"]+)"[^>]*>/g;
  for (const match of block.matchAll(linked)) {
    const [, href, src, alt] = match;
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({ html_url: href, avatar_url: src, display: alt });
  }
  const standalone = /<img src="([^"]+)"[^>]*alt="([^"]+)"[^>]*>/g;
  for (const match of block.matchAll(standalone)) {
    const [, src, alt] = match;
    if (!src || !alt) {
      continue;
    }
    if (entries.some((entry) => entry.display === alt && entry.avatar_url === src)) {
      continue;
    }
    entries.push({ html_url: fallbackHref(alt), avatar_url: src, display: alt });
  }
  return entries;
}

function parseHiddenReadmeLogins(content: string): string[] {
  const range = findHiddenReadmeRange(content);
  if (!range) {
    return [];
  }
  const block = content.slice(range.start, range.end);
  return block
    .split("\n")
    .map((line) => normalizeLogin(line.trim())?.toLowerCase() ?? null)
    .filter((login): login is string => Boolean(login));
}

function buildHiddenReadmeBlock(entries: Entry[], visibleEntries: Entry[]): string {
  const visibleLogins = new Set(
    visibleEntries
      .map((entry) => normalizeLogin(entry.login ?? entry.key)?.toLowerCase() ?? null)
      .filter((login): login is string => Boolean(login)),
  );
  const hiddenLogins = entries
    .map((entry) => normalizeLogin(entry.login ?? entry.key)?.toLowerCase() ?? null)
    .filter((login): login is string => Boolean(login))
    .filter((login) => !visibleLogins.has(login))
    .toSorted((a, b) => a.localeCompare(b));
  const notice =
    "default-avatar-cache: hidden from the rendered wall because these users still use GitHub's default avatar";
  if (hiddenLogins.length === 0) {
    return `${CLAWTRIBUTORS_HIDDEN_START}\n${notice}\n${CLAWTRIBUTORS_HIDDEN_END}\n`;
  }
  return `${CLAWTRIBUTORS_HIDDEN_START}\n${notice}\n${hiddenLogins.join("\n")}\n${CLAWTRIBUTORS_HIDDEN_END}\n`;
}

function findClawtributorsRange(content: string): { start: number; end: number } | null {
  const markerStart = content.indexOf(CLAWTRIBUTORS_START);
  const markerEnd = content.indexOf(CLAWTRIBUTORS_END, markerStart);
  if (markerStart !== -1 && markerEnd !== -1) {
    return {
      start: markerStart,
      end: markerEnd + CLAWTRIBUTORS_END.length,
    };
  }

  const legacyStart = content.indexOf('<p align="left">');
  const legacyEnd = content.indexOf("</p>", legacyStart);
  if (legacyStart === -1 || legacyEnd === -1) {
    return null;
  }
  return {
    start: legacyStart,
    end: legacyEnd + "</p>".length,
  };
}

function findHiddenReadmeRange(content: string): { start: number; end: number } | null {
  const markerStart = content.indexOf(CLAWTRIBUTORS_HIDDEN_START);
  const markerEnd = content.indexOf(CLAWTRIBUTORS_HIDDEN_END, markerStart);
  if (markerStart === -1 || markerEnd === -1) {
    return null;
  }
  return {
    start: markerStart,
    end: markerEnd + CLAWTRIBUTORS_HIDDEN_END.length,
  };
}

function loginFromUrl(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/?#]+)/i.exec(url);
  if (!match) {
    return null;
  }
  const login = match[1];
  if (!login || login.toLowerCase() === "search") {
    return null;
  }
  return login;
}

function fallbackHref(value: string): string {
  const encoded = encodeURIComponent(value.trim());
  return encoded ? `https://github.com/search?q=${encoded}` : "https://github.com";
}

function pickDisplay(
  baseName: string | null | undefined,
  login: string,
  existing?: string,
): string {
  const key = login.toLowerCase();
  if (displayName[key]) {
    return displayName[key];
  }
  if (existing) {
    return existing;
  }
  if (baseName) {
    return baseName;
  }
  return login;
}
