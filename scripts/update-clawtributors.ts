import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApiContributor, Entry, MapConfig, User } from "./update-clawtributors.types.js";

const REPO = "moltbot/moltbot";
const PER_LINE = 10;

const mapPath = resolve("scripts/clawtributors-map.json");
const mapConfig = JSON.parse(readFileSync(mapPath, "utf8")) as MapConfig;

const displayName = mapConfig.displayName ?? {};
const nameToLogin = normalizeMap(mapConfig.nameToLogin ?? {});
const emailToLogin = normalizeMap(mapConfig.emailToLogin ?? {});
const ensureLogins = (mapConfig.ensureLogins ?? []).map((login) => login.toLowerCase());

const readmePath = resolve("README.md");
const placeholderAvatar = mapConfig.placeholderAvatar ?? "assets/avatar-placeholder.svg";
const seedCommit = mapConfig.seedCommit ?? null;
const seedEntries = seedCommit ? parseReadmeEntries(run(`git show ${seedCommit}:README.md`)) : [];
const raw = run(`gh api "repos/${REPO}/contributors?per_page=100&anon=1" --paginate`);
const contributors = parsePaginatedJson(raw) as ApiContributor[];
const apiByLogin = new Map<string, User>();
const contributionsByLogin = new Map<string, number>();

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

const log = run("git log --format=%aN%x7c%aE --numstat");
const linesByLogin = new Map<string, number>();

let currentName: string | null = null;
let currentEmail: string | null = null;

for (const line of log.split("\n")) {
  if (!line.trim()) {
    continue;
  }

  if (line.includes("|") && !/^[0-9-]/.test(line)) {
    const [name, email] = line.split("|", 2);
    currentName = name?.trim() ?? null;
    currentEmail = email?.trim().toLowerCase() ?? null;
    continue;
  }

  if (!currentName) {
    continue;
  }

  const parts = line.split("\t");
  if (parts.length < 2) {
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

const entriesByKey = new Map<string, Entry>();

for (const seed of seedEntries) {
  const login = loginFromUrl(seed.html_url);
  const resolvedLogin =
    login ?? resolveLogin(seed.display, null, apiByLogin, nameToLogin, emailToLogin);
  const key = resolvedLogin ? resolvedLogin.toLowerCase() : `name:${normalizeName(seed.display)}`;
  const avatar =
    seed.avatar_url && !isGhostAvatar(seed.avatar_url)
      ? normalizeAvatar(seed.avatar_url)
      : placeholderAvatar;
  const existing = entriesByKey.get(key);
  if (!existing) {
    const user = resolvedLogin ? apiByLogin.get(key) : null;
    entriesByKey.set(key, {
      key,
      login: resolvedLogin ?? login ?? undefined,
      display: seed.display,
      html_url: user?.html_url ?? seed.html_url,
      avatar_url: user?.avatar_url ?? avatar,
      lines: 0,
    });
  } else {
    existing.display = existing.display || seed.display;
    if (existing.avatar_url === placeholderAvatar || !existing.avatar_url) {
      existing.avatar_url = avatar;
    }
    if (!existing.html_url || existing.html_url.includes("/search?q=")) {
      existing.html_url = seed.html_url;
    }
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

  if (resolvedLogin) {
    const key = resolvedLogin.toLowerCase();
    const existing = entriesByKey.get(key);
    if (!existing) {
      let user = apiByLogin.get(key) ?? fetchUser(resolvedLogin);
      if (user) {
        const lines = linesByLogin.get(key) ?? 0;
        const contributions = contributionsByLogin.get(key) ?? 0;
        entriesByKey.set(key, {
          key,
          login: user.login,
          display: pickDisplay(baseName, user.login, existing?.display),
          html_url: user.html_url,
          avatar_url: normalizeAvatar(user.avatar_url),
          lines: lines > 0 ? lines : contributions,
        });
      }
    } else if (existing) {
      existing.login = existing.login ?? resolvedLogin;
      existing.display = pickDisplay(baseName, existing.login, existing.display);
      if (existing.avatar_url === placeholderAvatar || !existing.avatar_url) {
        const user = apiByLogin.get(key) ?? fetchUser(resolvedLogin);
        if (user) {
          existing.html_url = user.html_url;
          existing.avatar_url = normalizeAvatar(user.avatar_url);
        }
      }
      const lines = linesByLogin.get(key) ?? 0;
      const contributions = contributionsByLogin.get(key) ?? 0;
      existing.lines = Math.max(existing.lines, lines > 0 ? lines : contributions);
    }
    continue;
  }

  const anonKey = `name:${normalizeName(baseName)}`;
  const existingAnon = entriesByKey.get(anonKey);
  if (!existingAnon) {
    entriesByKey.set(anonKey, {
      key: anonKey,
      display: baseName,
      html_url: fallbackHref(baseName),
      avatar_url: placeholderAvatar,
      lines: item.contributions ?? 0,
    });
  } else {
    existingAnon.lines = Math.max(existingAnon.lines, item.contributions ?? 0);
  }
}

for (const [login, lines] of linesByLogin.entries()) {
  if (entriesByKey.has(login)) {
    continue;
  }
  let user = apiByLogin.get(login);
  if (!user) {
    user = fetchUser(login);
  }
  if (user) {
    const contributions = contributionsByLogin.get(login) ?? 0;
    entriesByKey.set(login, {
      key: login,
      login: user.login,
      display: displayName[user.login.toLowerCase()] ?? user.login,
      html_url: user.html_url,
      avatar_url: normalizeAvatar(user.avatar_url),
      lines: lines > 0 ? lines : contributions,
    });
  } else {
    entriesByKey.set(login, {
      key: login,
      display: login,
      html_url: fallbackHref(login),
      avatar_url: placeholderAvatar,
      lines,
    });
  }
}

const entries = Array.from(entriesByKey.values());

entries.sort((a, b) => {
  if (b.lines !== a.lines) {
    return b.lines - a.lines;
  }
  return a.display.localeCompare(b.display);
});

const lines: string[] = [];
for (let i = 0; i < entries.length; i += PER_LINE) {
  const chunk = entries.slice(i, i + PER_LINE);
  const parts = chunk.map((entry) => {
    return `<a href=\"${entry.html_url}\"><img src=\"${entry.avatar_url}\" width=\"48\" height=\"48\" alt=\"${entry.display}\" title=\"${entry.display}\"/></a>`;
  });
  lines.push(`  ${parts.join(" ")}`);
}

const block = `${lines.join("\n")}\n`;
const readme = readFileSync(readmePath, "utf8");
const start = readme.indexOf('<p align="left">');
const end = readme.indexOf("</p>", start);

if (start === -1 || end === -1) {
  throw new Error("README.md missing clawtributors block");
}

const next = `${readme.slice(0, start)}<p align=\"left\">\n${block}${readme.slice(end)}`;
writeFileSync(readmePath, next);

console.log(`Updated README clawtributors: ${entries.length} entries`);

function run(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 200,
  }).trim();
}

function parsePaginatedJson(raw: string): any[] {
  const items: any[] = [];
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

function normalizeAvatar(url: string): string {
  if (!/^https?:/i.test(url)) {
    return url;
  }
  const lower = url.toLowerCase();
  if (lower.includes("s=") || lower.includes("size=")) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}s=48`;
}

function isGhostAvatar(url: string): boolean {
  return url.toLowerCase().includes("ghost.png");
}

function fetchUser(login: string): User | null {
  try {
    const data = execSync(`gh api users/${login}`, {
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

function resolveLogin(
  name: string,
  email: string | null,
  apiByLogin: Map<string, User>,
  nameToLogin: Record<string, string>,
  emailToLogin: Record<string, string>
): string | null {
  if (email && emailToLogin[email]) {
    return emailToLogin[email];
  }

  if (email && name) {
    const guessed = guessLoginFromEmailName(name, email, apiByLogin);
    if (guessed) {
      return guessed;
    }
  }

  if (email && email.endsWith("@users.noreply.github.com")) {
    const local = email.split("@", 1)[0];
    const login = local.includes("+") ? local.split("+")[1] : local;
    return login || null;
  }

  if (email && email.endsWith("@github.com")) {
    const login = email.split("@", 1)[0];
    if (apiByLogin.has(login.toLowerCase())) {
      return login;
    }
  }

  const normalized = normalizeName(name);
  if (nameToLogin[normalized]) {
    return nameToLogin[normalized];
  }

  const compact = normalized.replace(/\s+/g, "");
  if (nameToLogin[compact]) {
    return nameToLogin[compact];
  }

  if (apiByLogin.has(normalized)) {
    return normalized;
  }

  if (apiByLogin.has(compact)) {
    return compact;
  }

  return null;
}

function guessLoginFromEmailName(
  name: string,
  email: string,
  apiByLogin: Map<string, User>
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

function parseReadmeEntries(
  content: string
): Array<{ display: string; html_url: string; avatar_url: string }> {
  const start = content.indexOf('<p align="left">');
  const end = content.indexOf("</p>", start);
  if (start === -1 || end === -1) {
    return [];
  }
  const block = content.slice(start, end);
  const entries: Array<{ display: string; html_url: string; avatar_url: string }> = [];
  const linked = /<a href=\"([^\"]+)\"><img src=\"([^\"]+)\"[^>]*alt=\"([^\"]+)\"[^>]*>/g;
  for (const match of block.matchAll(linked)) {
    const [, href, src, alt] = match;
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({ html_url: href, avatar_url: src, display: alt });
  }
  const standalone = /<img src=\"([^\"]+)\"[^>]*alt=\"([^\"]+)\"[^>]*>/g;
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

function loginFromUrl(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([^\/?#]+)/i.exec(url);
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

function pickDisplay(baseName: string | null | undefined, login: string, existing?: string): string {
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
