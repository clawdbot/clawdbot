import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function spawnOpenClaw(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/entry.ts", ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function buildGitHubSkillZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("skills-main/skills/aiq-deploy/SKILL.md", "# AIQ Deploy\n");
  zip.file("skills-main/skills/aiq-deploy/skill-card.md", "# Card\n");
  zip.file("skills-main/skills/other/SKILL.md", "# Other\n");
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("openclaw skills install ClawHub GitHub-backed E2E", () => {
  it("installs from the install resolver and reports install telemetry", async () => {
    const commit = "c".repeat(40);
    const telemetryBodies: unknown[] = [];
    const requestLog: string[] = [];
    const githubZipBytes = await buildGitHubSkillZip();
    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requestLog.push(`${req.method ?? "GET"} ${url.pathname}`);

      if (req.method === "GET" && url.pathname === "/api/v1/skills/aiq-deploy/install") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            slug: "aiq-deploy",
            installKind: "github",
            github: {
              repo: "NVIDIA/skills",
              path: "skills/aiq-deploy",
              commit,
              contentHash: "hash-aiq-deploy",
              sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
            },
          }),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === `/NVIDIA/skills/zip/${commit}`) {
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(githubZipBytes);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli/telemetry/install") {
        telemetryBodies.push(JSON.parse(await readRequestBody(req)) as unknown);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
    const server = createServer((req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-cli-e2e-"));
    try {
      const result = await spawnOpenClaw(["skills", "install", "aiq-deploy", "--global"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_CLAWHUB_URL: registry,
          OPENCLAW_CLAWHUB_TOKEN: "test-token",
          OPENCLAW_CLAWHUB_GITHUB_CODELOAD_BASE_URL: registry,
          CLAWHUB_DISABLE_TELEMETRY: "",
          CLAWDHUB_DISABLE_TELEMETRY: "",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      await expect(
        fs.readFile(path.join(stateDir, "skills", "aiq-deploy", "SKILL.md"), "utf8"),
      ).resolves.toContain("# AIQ Deploy");
      await expect(
        fs.readFile(path.join(stateDir, "skills", "aiq-deploy", "skill-card.md"), "utf8"),
      ).resolves.toContain("# Card");
      await expect(
        fs.readFile(path.join(stateDir, "skills", "aiq-deploy", "other", "SKILL.md")),
      ).rejects.toThrow();
      if (telemetryBodies.length !== 1) {
        throw new Error(`Expected one install telemetry request, saw: ${requestLog.join(", ")}`);
      }
      expect(telemetryBodies[0]).toMatchObject({
        roots: [
          {
            skills: [{ slug: "aiq-deploy", version: commit }],
          },
        ],
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
