import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CoreChannelDeps = {
  chunkMarkdownText: (text: string, limit: number) => string[];
  formatAgentEnvelope: (params: {
    channel: string;
    from: string;
    timestamp?: number;
    body: string;
  }) => string;
  dispatchReplyWithBufferedBlockDispatcher: (params: {
    ctx: unknown;
    cfg: unknown;
    dispatcherOptions: {
      deliver: (payload: unknown) => Promise<void>;
      onError?: (err: unknown, info: { kind: string }) => void;
    };
  }) => Promise<void>;
  resolveAgentRoute: (params: {
    cfg: unknown;
    channel: string;
    accountId: string;
    peer: { kind: "dm" | "group" | "channel"; id: string };
  }) => { sessionKey: string; accountId: string };
  buildPairingReply: (params: { channel: string; idLine: string; code: string }) => string;
  readChannelAllowFromStore: (channel: string) => Promise<string[]>;
  upsertChannelPairingRequest: (params: {
    channel: string;
    id: string;
    meta?: { name?: string };
  }) => Promise<{ code: string; created: boolean }>;
  fetchRemoteMedia: (params: { url: string }) => Promise<{ buffer: Buffer; contentType?: string }>;
  saveMediaBuffer: (
    buffer: Buffer,
    contentType: string | undefined,
    type: "inbound" | "outbound",
    maxBytes: number,
  ) => Promise<{ path: string; contentType: string }>;
  shouldLogVerbose: () => boolean;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreChannelDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore parse errors
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveClawdbotRoot(): string {
  if (coreRootCache) return coreRootCache;
  const override = process.env.CLAWDBOT_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set<string>();
  if (process.argv[1]) {
    candidates.add(path.dirname(process.argv[1]));
  }
  candidates.add(process.cwd());
  try {
    const urlPath = fileURLToPath(import.meta.url);
    candidates.add(path.dirname(urlPath));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    const found = findPackageRoot(start, "clawdbot");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }

  throw new Error(
    "Unable to resolve Clawdbot root. Set CLAWDBOT_ROOT to the package root.",
  );
}

async function importCoreModule<T>(relativePath: string): Promise<T> {
  const root = resolveClawdbotRoot();
  const distPath = path.join(root, "dist", relativePath);
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`,
    );
  }
  return (await import(pathToFileURL(distPath).href)) as T;
}

export async function loadCoreChannelDeps(): Promise<CoreChannelDeps> {
  if (coreDepsPromise) return coreDepsPromise;

  coreDepsPromise = (async () => {
    const [
      chunk,
      envelope,
      dispatcher,
      routing,
      pairingMessages,
      pairingStore,
      mediaFetch,
      mediaStore,
      globals,
    ] = await Promise.all([
      importCoreModule<{ chunkMarkdownText: CoreChannelDeps["chunkMarkdownText"] }>(
        "auto-reply/chunk.js",
      ),
      importCoreModule<{ formatAgentEnvelope: CoreChannelDeps["formatAgentEnvelope"] }>(
        "auto-reply/envelope.js",
      ),
      importCoreModule<{
        dispatchReplyWithBufferedBlockDispatcher: CoreChannelDeps["dispatchReplyWithBufferedBlockDispatcher"];
      }>("auto-reply/reply/provider-dispatcher.js"),
      importCoreModule<{ resolveAgentRoute: CoreChannelDeps["resolveAgentRoute"] }>(
        "routing/resolve-route.js",
      ),
      importCoreModule<{ buildPairingReply: CoreChannelDeps["buildPairingReply"] }>(
        "pairing/pairing-messages.js",
      ),
      importCoreModule<{
        readChannelAllowFromStore: CoreChannelDeps["readChannelAllowFromStore"];
        upsertChannelPairingRequest: CoreChannelDeps["upsertChannelPairingRequest"];
      }>("pairing/pairing-store.js"),
      importCoreModule<{ fetchRemoteMedia: CoreChannelDeps["fetchRemoteMedia"] }>(
        "media/fetch.js",
      ),
      importCoreModule<{ saveMediaBuffer: CoreChannelDeps["saveMediaBuffer"] }>(
        "media/store.js",
      ),
      importCoreModule<{ shouldLogVerbose: CoreChannelDeps["shouldLogVerbose"] }>(
        "globals.js",
      ),
    ]);

    return {
      chunkMarkdownText: chunk.chunkMarkdownText,
      formatAgentEnvelope: envelope.formatAgentEnvelope,
      dispatchReplyWithBufferedBlockDispatcher:
        dispatcher.dispatchReplyWithBufferedBlockDispatcher,
      resolveAgentRoute: routing.resolveAgentRoute,
      buildPairingReply: pairingMessages.buildPairingReply,
      readChannelAllowFromStore: pairingStore.readChannelAllowFromStore,
      upsertChannelPairingRequest: pairingStore.upsertChannelPairingRequest,
      fetchRemoteMedia: mediaFetch.fetchRemoteMedia,
      saveMediaBuffer: mediaStore.saveMediaBuffer,
      shouldLogVerbose: globals.shouldLogVerbose,
    };
  })();

  return coreDepsPromise;
}
