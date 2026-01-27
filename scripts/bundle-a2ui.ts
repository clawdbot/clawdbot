import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HASH_FILE = path.join(repoRoot, "src", "canvas-host", "a2ui", ".bundle.hash");
const OUTPUT_FILE = path.join(repoRoot, "src", "canvas-host", "a2ui", "a2ui.bundle.js");

const INPUT_PATHS = [
  path.join(repoRoot, "package.json"),
  path.join(repoRoot, "pnpm-lock.yaml"),
  path.join(repoRoot, "vendor", "a2ui", "renderers", "lit"),
  path.join(repoRoot, "apps", "shared", "ClawdbotKit", "Tools", "CanvasA2UI"),
];

async function exists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function collectInputFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const p of INPUT_PATHS) {
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      files.push(...(await listFiles(p)));
    } else {
      files.push(p);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "en"));
  return files;
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function computeHash(): Promise<string> {
  const inputs = await collectInputFiles();
  const h = crypto.createHash("sha256");
  for (const p of inputs) {
    // include relative path to avoid collisions and keep stable ordering
    const rel = path.relative(repoRoot, p).replace(/\\/g, "/");
    h.update(rel);
    h.update("\0");
    h.update(await fs.readFile(p));
    h.update("\0");
  }
  return h.digest("hex");
}

function run(cmd: string, args: string[], label: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" });
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${label} failed (code=${code ?? "?"}${signal ? ` signal=${signal}` : ""})`));
    });
  });
}

async function main() {
  const currentHash = await computeHash();
  const previousHash = (await exists(HASH_FILE)) ? (await fs.readFile(HASH_FILE, "utf8")).trim() : null;

  if (previousHash && previousHash === currentHash && (await exists(OUTPUT_FILE))) {
    console.log("A2UI bundle up to date; skipping.");
    return;
  }

  // Build vendor A2UI lit renderer TS output, then bundle our bootstrap.
  await run("pnpm", ["-s", "exec", "tsc", "-p", "vendor/a2ui/renderers/lit/tsconfig.json"], "A2UI lit tsc");
  await run("pnpm", ["-s", "exec", "rolldown", "-c", "apps/shared/ClawdbotKit/Tools/CanvasA2UI/rolldown.config.mjs"], "A2UI rolldown");

  await fs.writeFile(HASH_FILE, `${currentHash}\n`, "utf8");

  // sanity
  const outHash = await sha256File(OUTPUT_FILE);
  if (!outHash) throw new Error("A2UI bundle not generated");
}

main().catch((err) => {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error(String(err));
  process.exit(1);
});
