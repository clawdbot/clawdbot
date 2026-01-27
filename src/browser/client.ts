import { fetchBrowserJson } from "./client-fetch.js";

export type BrowserStatus = {
  enabled: boolean;
  profile?: string;
  running: boolean;
  cdpReady?: boolean;
  cdpHttp?: boolean;
  pid: number | null;
  cdpPort: number;
  cdpUrl?: string;
  chosenBrowser: string | null;
  detectedBrowser?: string | null;
  detectedExecutablePath?: string | null;
  detectError?: string | null;
  userDataDir: string | null;
  color: string;
  headless: boolean;
  noSandbox?: boolean;
  executablePath?: string | null;
  attachOnly: boolean;
};

export type ProfileStatus = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  color: string;
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
};

export type BrowserResetProfileResult = {
  ok: true;
  moved: boolean;
  from: string;
  to?: string;
};

export type BrowserTab = {
  targetId: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};

export type SnapshotAriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};

export type SnapshotResult =
  | {
      ok: true;
      format: "aria";
      targetId: string;
      url: string;
      nodes: SnapshotAriaNode[];
    }
  | {
      ok: true;
      format: "ai";
      targetId: string;
      url: string;
      snapshot: string;
      truncated?: boolean;
      refs?: Record<string, { role: string; name?: string; nth?: number }>;
      stats?: {
        lines: number;
        chars: number;
        refs: number;
        interactive: number;
      };
      labels?: boolean;
      labelsCount?: number;
      labelsSkipped?: number;
      imagePath?: string;
      imageType?: "png" | "jpeg";
    };

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return path;
  return `${trimmed.replace(/\/$/, "")}${path}`;
}

export async function browserStatus(
  baseUrl?: string,
  opts?: { profile?: string },
): Promise<BrowserStatus> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserStatus>(withBaseUrl(baseUrl, `/${q}`), {
    timeoutMs: 1500,
  });
}

export async function browserProfiles(baseUrl?: string): Promise<ProfileStatus[]> {
  const res = await fetchBrowserJson<{ profiles: ProfileStatus[] }>(
    withBaseUrl(baseUrl, `/profiles`),
    {
      timeoutMs: 3000,
    },
  );
  return res.profiles ?? [];
}

export async function browserStart(baseUrl?: string, opts?: { profile?: string }): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/start${q}`), {
    method: "POST",
    timeoutMs: 15000,
  });
}

export async function browserStop(baseUrl?: string, opts?: { profile?: string }): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/stop${q}`), {
    method: "POST",
    timeoutMs: 15000,
  });
}

export async function browserResetProfile(
  baseUrl?: string,
  opts?: { profile?: string },
): Promise<BrowserResetProfileResult> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserResetProfileResult>(
    withBaseUrl(baseUrl, `/reset-profile${q}`),
    {
      method: "POST",
      timeoutMs: 20000,
    },
  );
}

export type BrowserCreateProfileResult = {
  ok: true;
  profile: string;
  cdpPort: number;
  cdpUrl: string;
  color: string;
  isRemote: boolean;
};

export async function browserCreateProfile(
  baseUrl: string | undefined,
  opts: {
    name: string;
    color?: string;
    cdpUrl?: string;
    driver?: "clawd" | "extension";
  },
): Promise<BrowserCreateProfileResult> {
  return await fetchBrowserJson<BrowserCreateProfileResult>(
    withBaseUrl(baseUrl, `/profiles/create`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        color: opts.color,
        cdpUrl: opts.cdpUrl,
        driver: opts.driver,
      }),
      timeoutMs: 10000,
    },
  );
}

export type BrowserDeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};

export async function browserDeleteProfile(
  baseUrl: string | undefined,
  profile: string,
): Promise<BrowserDeleteProfileResult> {
  return await fetchBrowserJson<BrowserDeleteProfileResult>(
    withBaseUrl(baseUrl, `/profiles/${encodeURIComponent(profile)}`),
    {
      method: "DELETE",
      timeoutMs: 20000,
    },
  );
}

export async function browserTabs(
  baseUrl?: string,
  opts?: { profile?: string },
): Promise<BrowserTab[]> {
  const q = buildProfileQuery(opts?.profile);
  const res = await fetchBrowserJson<{ running: boolean; tabs: BrowserTab[] }>(
    withBaseUrl(baseUrl, `/tabs${q}`),
    { timeoutMs: 3000 },
  );
  return res.tabs ?? [];
}

export async function browserOpenTab(
  baseUrl: string | undefined,
  url: string,
  opts?: { profile?: string },
): Promise<BrowserTab> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserTab>(withBaseUrl(baseUrl, `/tabs/open${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    timeoutMs: 15000,
  });
}

export async function browserFocusTab(
  baseUrl: string | undefined,
  targetId: string,
  opts?: { profile?: string },
): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/focus${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId }),
    timeoutMs: 5000,
  });
}

export async function browserCloseTab(
  baseUrl: string | undefined,
  targetId: string,
  opts?: { profile?: string },
): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/${encodeURIComponent(targetId)}${q}`), {
    method: "DELETE",
    timeoutMs: 5000,
  });
}

export async function browserTabAction(
  baseUrl: string | undefined,
  opts: {
    action: "list" | "new" | "close" | "select";
    index?: number;
    profile?: string;
  },
): Promise<unknown> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/action${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: opts.action,
      index: opts.index,
    }),
    timeoutMs: 10_000,
  });
}

export async function browserSnapshot(
  baseUrl: string | undefined,
  opts: {
    format: "aria" | "ai";
    targetId?: string;
    limit?: number;
    maxChars?: number;
    refs?: "role" | "aria";
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    selector?: string;
    frame?: string;
    labels?: boolean;
    mode?: "efficient";
    profile?: string;
  },
): Promise<SnapshotResult> {
  const q = new URLSearchParams();
  q.set("format", opts.format);
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (typeof opts.limit === "number") q.set("limit", String(opts.limit));
  if (typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)) {
    q.set("maxChars", String(opts.maxChars));
  }
  if (opts.refs === "aria" || opts.refs === "role") q.set("refs", opts.refs);
  if (typeof opts.interactive === "boolean") q.set("interactive", String(opts.interactive));
  if (typeof opts.compact === "boolean") q.set("compact", String(opts.compact));
  if (typeof opts.depth === "number" && Number.isFinite(opts.depth))
    q.set("depth", String(opts.depth));
  if (opts.selector?.trim()) q.set("selector", opts.selector.trim());
  if (opts.frame?.trim()) q.set("frame", opts.frame.trim());
  if (opts.labels === true) q.set("labels", "1");
  if (opts.mode) q.set("mode", opts.mode);
  if (opts.profile) q.set("profile", opts.profile);
  return await fetchBrowserJson<SnapshotResult>(withBaseUrl(baseUrl, `/snapshot?${q.toString()}`), {
    timeoutMs: 20000,
  });
}

// Actions beyond the basic read-only commands live in client-actions.ts.
