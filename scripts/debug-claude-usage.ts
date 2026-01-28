import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

type Args = {
  agentId: string;
  reveal: boolean;
  sessionKey?: string;
};

const mask = (value: string) => {
  const compact = value.trim();
  if (!compact) return "missing";
  const edge = compact.length >= 12 ? 6 : 4;
  return `${compact.slice(0, edge)}…${compact.slice(-edge)}`;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  let agentId = "main";
  let reveal = false;
  let sessionKey: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent" && args[i + 1]) {
      agentId = String(args[++i]).trim() || "main";
      continue;
    }
    if (arg === "--reveal") {
      reveal = true;
      continue;
    }
    if (arg === "--session-key" && args[i + 1]) {
      sessionKey = String(args[++i]).trim() || undefined;
      continue;
    }
  }

  return { agentId, reveal, sessionKey };
};

const loadAuthProfiles = (agentId: string) => {
  const stateRoot =
    process.env.CLAWDBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".clawdbot");
  const authPath = path.join(stateRoot, "agents", agentId, "agent", "auth-profiles.json");
  if (!fs.existsSync(authPath)) throw new Error(`Missing: ${authPath}`);
  const store = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
    profiles?: Record<string, { provider?: string; type?: string; token?: string; key?: string }>;
  };
  return { authPath, store };
};

const pickAnthropicTokens = (store: {
  profiles?: Record<string, { provider?: string; type?: string; token?: string; key?: string }>;
}): Array<{ profileId: string; token: string }> => {
  const profiles = store.profiles ?? {};
  const found: Array<{ profileId: string; token: string }> = [];
  for (const [id, cred] of Object.entries(profiles)) {
    if (cred?.provider !== "anthropic") continue;
    const token = cred.type === "token" ? cred.token?.trim() : undefined;
    if (token) found.push({ profileId: id, token });
  }
  return found;
};

const fetchAnthropicOAuthUsage = async (token: string) => {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "moltbot-debug",
    },
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), text };
};

const readClaudeCliKeychain = (): {
  accessToken: string;
  expiresAt?: number;
  scopes?: string[];
} | null => {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    const oauth = parsed?.claudeAiOauth as Record<string, unknown> | undefined;
    if (!oauth || typeof oauth !== "object") return null;
    const accessToken = oauth.accessToken;
    if (typeof accessToken !== "string" || !accessToken.trim()) return null;
    const expiresAt =
      typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((v): v is string => typeof v === "string")
      : undefined;
    return { accessToken, expiresAt, scopes };
  } catch {
    return null;
  }
};

const chromeServiceNameForPath = (cookiePath: string): string => {
  if (cookiePath.includes("/Arc/")) return "Arc Safe Storage";
  if (cookiePath.includes("/BraveSoftware/")) return "Brave Safe Storage";
  if (cookiePath.includes("/Microsoft Edge/")) return "Microsoft Edge Safe Storage";
  if (cookiePath.includes("/Chromium/")) return "Chromium Safe Storage";
  return "Chrome Safe Storage";
};

const readKeychainPassword = (service: string): string | null => {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", service],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    const pw = out.trim();
    return pw ? pw : null;
  } catch {
    return null;
  }
};

const decryptChromeCookieValue = (encrypted: Buffer, service: string): string | null => {
  if (encrypted.length < 4) return null;
  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") return null;

  const password = readKeychainPassword(service);
  if (!password) return null;

  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const data = encrypted.subarray(3);

  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    const text = decrypted.toString("utf8").trim();
    return text ? text : null;
  } catch {
    return null;
  }
};

const queryChromeCookieDb = (cookieDb: string): string | null => {
  try {
    const out = execFileSync(
      "sqlite3",
      [
        "-readonly",
        cookieDb,
        `
          SELECT
            COALESCE(NULLIF(value,''), hex(encrypted_value))
          FROM cookies
          WHERE (host_key LIKE '%claude.ai%' OR host_key = '.claude.ai')
            AND name = 'sessionKey'
          LIMIT 1;
        `,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    ).trim();
    if (!out) return null;
    if (out.startsWith("sk-ant-")) return out;
    const hex = out.replace(/[^0-9A-Fa-f]/g, "");
    if (!hex) return null;
    const buf = Buffer.from(hex, "hex");
    const service = chromeServiceNameForPath(cookieDb);
    const decrypted = decryptChromeCookieValue(buf, service);
    return decrypted && decrypted.startsWith("sk-ant-") ? decrypted : null;
  } catch {
    return null;
  }
};

const queryFirefoxCookieDb = (cookieDb: string): string | null => {
  try {
    const out = execFileSync(
      "sqlite3",
      [
        "-readonly",
        cookieDb,
        `
          SELECT value
          FROM moz_cookies
          WHERE (host LIKE '%claude.ai%' OR host = '.claude.ai')
            AND name = 'sessionKey'
          LIMIT 1;
        `,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    ).trim();
    return out && out.startsWith("sk-ant-") ? out : null;
  } catch {
    return null;
  }
};

const findClaudeSessionKey = (): { sessionKey: string; source: string } | null => {
  if (process.platform !== "darwin") return null;

  const firefoxRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Firefox",
    "Profiles",
  );
  if (fs.existsSync(firefoxRoot)) {
    for (const entry of fs.readdirSync(firefoxRoot)) {
      const db = path.join(firefoxRoot, entry, "cookies.sqlite");
      if (!fs.existsSync(db)) continue;
      const value = queryFirefoxCookieDb(db);
      if (value) return { sessionKey: value, source: `firefox:${db}` };
    }
  }

  const chromeCandidates = [
    path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
    path.join(os.homedir(), "Library", "Application Support", "Chromium"),
    path.join(os.homedir(), "Library", "Application Support", "Arc"),
    path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    path.join(os.homedir(), "Library", "Application Support", "Microsoft Edge"),
  ];

  for (const root of chromeCandidates) {
    if (!fs.existsSync(root)) continue;
    const profiles = fs
      .readdirSync(root)
      .filter((name) => name === "Default" || name.startsWith("Profile "));
    for (const profile of profiles) {
      const db = path.join(root, profile, "Cookies");
      if (!fs.existsSync(db)) continue;
      const value = queryChromeCookieDb(db);
      if (value) return { sessionKey: value, source: `chromium:${db}` };
    }
  }

  return null;
};

const fetchClaudeWebUsage = async (sessionKey: string) => {
  const headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  };
  const orgRes = await fetch("https://claude.ai/api/organizations", { headers });
  const orgText = await orgRes.text();
  if (!orgRes.ok) {
    return { ok: false as const, step: "organizations", status: orgRes.status, body: orgText };
  }
  const orgs = JSON.parse(orgText) as Array<{ uuid?: string }>;
  const orgId = orgs?.[0]?.uuid;
  if (!orgId) {
    return { ok: false as const, step: "organizations", status: 200, body: orgText };
  }

  const usageRes = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, { headers });
  const usageText = await usageRes.text();
  return usageRes.ok
    ? { ok: true as const, orgId, body: usageText }
    : { ok: false as const, step: "usage", status: usageRes.status, body: usageText };
};

const main = async () => {
  const opts = parseArgs();
  const { authPath, store } = loadAuthProfiles(opts.agentId);
  console.log(`Auth file: ${authPath}`);

  const keychain = readClaudeCliKeychain();
  if (keychain) {
    console.log(
      `Claude Code CLI keychain: accessToken=${opts.reveal ? keychain.accessToken : mask(keychain.accessToken)} scopes=${keychain.scopes?.join(",") ?? "(unknown)"}`,
    );
    const oauth = await fetchAnthropicOAuthUsage(keychain.accessToken);
    console.log(
      `OAuth usage (keychain): HTTP ${oauth.status} (${oauth.contentType ?? "no content-type"})`,
    );
    console.log(oauth.text.slice(0, 200).replace(/\s+/g, " ").trim());
  } else {
    console.log("Claude Code CLI keychain: missing/unreadable");
  }

  const anthropic = pickAnthropicTokens(store);
  if (anthropic.length === 0) {
    console.log("Auth profiles: no Anthropic token profiles found");
  } else {
    for (const entry of anthropic) {
      console.log(
        `Auth profiles: ${entry.profileId} token=${opts.reveal ? entry.token : mask(entry.token)}`,
      );
      const oauth = await fetchAnthropicOAuthUsage(entry.token);
      console.log(
        `OAuth usage (${entry.profileId}): HTTP ${oauth.status} (${oauth.contentType ?? "no content-type"})`,
      );
      console.log(oauth.text.slice(0, 200).replace(/\s+/g, " ").trim());
    }
  }

  const sessionKey =
    opts.sessionKey?.trim() ||
    process.env.CLAUDE_AI_SESSION_KEY?.trim() ||
    process.env.CLAUDE_WEB_SESSION_KEY?.trim() ||
    findClaudeSessionKey()?.sessionKey;
  const source =
    opts.sessionKey
      ? "--session-key"
      : process.env.CLAUDE_AI_SESSION_KEY || process.env.CLAUDE_WEB_SESSION_KEY
        ? "env"
        : findClaudeSessionKey()?.source ?? "auto";

  if (!sessionKey) {
    console.log("Claude web: no sessionKey found (try --session-key or export CLAUDE_AI_SESSION_KEY)");
    return;
  }

  console.log(
    `Claude web: sessionKey=${opts.reveal ? sessionKey : mask(sessionKey)} (source: ${source})`,
  );
  const web = await fetchClaudeWebUsage(sessionKey);
  if (!web.ok) {
    console.log(`Claude web: ${web.step} HTTP ${web.status}`);
    console.log(String(web.body).slice(0, 400).replace(/\s+/g, " ").trim());
    return;
  }
  console.log(`Claude web: org=${web.orgId} OK`);
  console.log(web.body.slice(0, 400).replace(/\s+/g, " ").trim());
};

await main();
