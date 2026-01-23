import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let coreRootCache = null;
let coreDepsPromise = null;

function findPackageRoot(startDir, name) {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw);
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

function resolveClawdbotRoot() {
  if (coreRootCache) return coreRootCache;
  const override = process.env.CLAWDBOT_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set();
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

async function importCoreModule(relativePath) {
  const root = resolveClawdbotRoot();
  const distPath = path.join(root, "dist", relativePath);
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`,
    );
  }
  return await import(pathToFileURL(distPath).href);
}

export async function loadCoreChannelDeps() {
  if (coreDepsPromise) return coreDepsPromise;

  coreDepsPromise = (async () => {
    const [
      chunk,
      envelope,
      dispatcher,
      routing,
      inboundContext,
    ] = await Promise.all([
      importCoreModule("auto-reply/chunk.js"),
      importCoreModule("auto-reply/envelope.js"),
      importCoreModule("auto-reply/reply/provider-dispatcher.js"),
      importCoreModule("routing/resolve-route.js"),
      importCoreModule("auto-reply/reply/inbound-context.js"),
    ]);

    return {
      chunkMarkdownText: chunk.chunkMarkdownText,
      formatAgentEnvelope: envelope.formatAgentEnvelope,
      dispatchReplyWithBufferedBlockDispatcher:
        dispatcher.dispatchReplyWithBufferedBlockDispatcher,
      resolveAgentRoute: routing.resolveAgentRoute,
      finalizeInboundContext: inboundContext.finalizeInboundContext,
    };
  })();

  return coreDepsPromise;
}
