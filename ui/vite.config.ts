import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.resolve(here, "../dist/control-ui");

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

function normalizeBuildId(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.slice(0, 96) || "dev";
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "dev";
  } catch {
    return "dev";
  }
}

function readGitShortSha(): string | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function resolveControlUiBuildId(): string {
  const explicit =
    process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim() || process.env.OPENCLAW_VERSION?.trim();
  if (explicit) {
    return normalizeBuildId(explicit);
  }
  const version = readPackageVersion();
  const gitSha = readGitShortSha();
  return normalizeBuildId(gitSha ? `${version}-${gitSha}` : version);
}

function controlUiServiceWorkerBuildIdPlugin(buildId: string): Plugin {
  return {
    name: "control-ui-service-worker-build-id",
    apply: "build",
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      const source = fs.readFileSync(swPath, "utf8");
      const placeholder = '"__OPENCLAW_CONTROL_UI_BUILD_ID__"';
      const updated = source.replace(placeholder, JSON.stringify(buildId));
      if (updated === source) {
        throw new Error(`Control UI service worker build id placeholder missing in ${swPath}`);
      }
      fs.writeFileSync(swPath, updated);
    },
  };
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const controlUiBuildId = resolveControlUiBuildId();
  return {
    base,
    define: {
      __OPENCLAW_CONTROL_UI_BUILD_ID__: JSON.stringify(controlUiBuildId),
    },
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
      controlUiServiceWorkerBuildIdPlugin(controlUiBuildId),
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
    ],
  };
});
