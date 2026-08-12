import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TEST_TIMEOUT_MS = 30_000;
const SKILL_CARD = "# Catalog Proof\n\nLocal Gateway skill-card evidence.\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_CLAWHUB_URL",
] as const;

async function startDuplicatePublisherRegistry(requests: URL[]): Promise<{
  baseUrl: string;
  server: Server;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    response.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/search") {
      response.end(
        JSON.stringify({
          results: [
            { score: 1, slug: "weather", ownerHandle: "alice", displayName: "Alice Weather" },
            { score: 0.9, slug: "weather", ownerHandle: "bob", displayName: "Bob Weather" },
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/api/v1/skills/weather") {
      const ownerHandle = url.searchParams.get("ownerHandle");
      if (ownerHandle === "alice" || ownerHandle === "bob") {
        response.end(
          JSON.stringify({
            skill: {
              slug: "weather",
              displayName: `${ownerHandle === "alice" ? "Alice" : "Bob"} Weather`,
              createdAt: 1,
              updatedAt: 1,
            },
            latestVersion: { version: "1.0.0", createdAt: 1 },
            owner: { handle: ownerHandle, displayName: ownerHandle },
          }),
        );
        return;
      }
    }

    if (url.pathname === "/api/v1/skills/weather/install") {
      response.statusCode = 423;
      response.end(
        JSON.stringify({
          ok: false,
          slug: "weather",
          reason: "fixture-stop-before-download",
          message: "Fixture stopped before download.",
          status: 423,
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("duplicate publisher registry did not bind a TCP port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function setupTempHome() {
  const env = captureEnv([...ENV_KEYS]);
  const home = tempDirs.make("openclaw-rpc-tools-skills-");
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  const skillDir = path.join(workspace, "skills", "catalog-proof");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(skillDir, { recursive: true }),
    fs.mkdir(bundledPlugins, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: catalog-proof",
      "description: Fixture skill for Gateway catalog proof.",
      "---",
      "",
      "# Catalog Proof",
      "",
      "Use this fixture only for local QA evidence.",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, "skill-card.md"), SKILL_CARD, "utf8");
  setTestEnvValue("HOME", home);
  setTestEnvValue("USERPROFILE", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPlugins);
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return {
    configPath: path.join(stateDir, "openclaw.json"),
    env,
    home,
    skillDir,
    workspace,
  };
}

describe("gateway RPC tool and skill catalogs", () => {
  it(
    "keeps the selected publisher through search, detail, and install",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const temp = await setupTempHome();
      const requests: URL[] = [];
      const registry = await startDuplicatePublisherRegistry(requests);
      const token = `rpc-clawhub-publishers-${process.pid}`;
      let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        setTestEnvValue("OPENCLAW_CLAWHUB_URL", registry.baseUrl);
        started = await startGatewayWithClient({
          cfg: {
            agents: { defaults: { workspace: temp.workspace } },
            gateway: { auth: { mode: "token", token } },
          },
          configPath: temp.configPath,
          token,
          clientDisplayName: "rpc-clawhub-publisher-reader",
        });

        const search = (await started.client.request("skills.search", {
          query: "weather",
        })) as { results: Array<{ slug: string; ownerHandle?: string }> };
        expect(search.results).toEqual([
          expect.objectContaining({ slug: "weather", ownerHandle: "alice" }),
          expect.objectContaining({ slug: "weather", ownerHandle: "bob" }),
        ]);

        const detail = (await started.client.request("skills.detail", {
          slug: "@alice/weather",
        })) as { owner?: { handle?: string } };
        expect(detail.owner?.handle).toBe("alice");

        await expect(
          started.client.request("skills.install", {
            source: "clawhub",
            slug: "@bob/weather",
          }),
        ).rejects.toThrow("Fixture stopped before download");
        expect(
          requests.some(
            (request) =>
              request.pathname === "/api/v1/skills/weather/install" &&
              request.searchParams.get("ownerHandle") === "bob",
          ),
        ).toBe(true);
      } finally {
        try {
          if (started) {
            await disconnectGatewayClient(started.client).catch(() => undefined);
            await started.server.close({ reason: "publisher identity proof complete" });
          }
          await new Promise<void>((resolve) => registry.server.close(() => resolve()));
        } finally {
          temp.env.restore();
        }
      }
    },
  );

  it(
    "returns built-in commands, core tools, and a readable workspace skill card",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const temp = await setupTempHome();
      const token = `rpc-tools-skills-${process.pid}`;
      let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        started = await startGatewayWithClient({
          cfg: {
            agents: { defaults: { workspace: temp.workspace } },
            gateway: { auth: { mode: "token", token } },
          },
          configPath: temp.configPath,
          token,
          clientDisplayName: "rpc-tools-skills-reader",
        });

        const commands = (await started.client.request("commands.list", {})) as {
          commands: Array<{ name: string; source: string }>;
        };
        expect(commands.commands).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "model", source: "native" })]),
        );

        const tools = (await started.client.request("tools.catalog", {
          includePlugins: false,
        })) as {
          groups: Array<{ source: string; tools: Array<{ id: string; source: string }> }>;
        };
        expect(tools.groups.flatMap((group) => group.tools)).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "tts", source: "core" })]),
        );
        expect(tools.groups.some((group) => group.source === "plugin")).toBe(false);

        const status = (await started.client.request("skills.status", {})) as {
          workspaceDir: string;
          skills: Array<{
            name: string;
            skillKey: string;
            skillCard?: { path: string; present: boolean; sizeBytes: number };
          }>;
        };
        expect(status.workspaceDir).toBe(temp.workspace);
        const fixture = status.skills.find((skill) => skill.name === "catalog-proof");
        expect(fixture).toEqual(
          expect.objectContaining({
            name: "catalog-proof",
            skillKey: "catalog-proof",
            skillCard: {
              path: path.join(temp.skillDir, "skill-card.md"),
              present: true,
              sizeBytes: Buffer.byteLength(SKILL_CARD),
            },
          }),
        );

        const card = await started.client.request("skills.skillCard", {
          skillKey: "catalog-proof",
        });
        expect(card).toEqual({
          schema: "openclaw.skills.skill-card.v1",
          skillKey: "catalog-proof",
          path: path.join(temp.skillDir, "skill-card.md"),
          sizeBytes: Buffer.byteLength(SKILL_CARD),
          content: SKILL_CARD,
        });
      } finally {
        try {
          if (started) {
            await disconnectGatewayClient(started.client).catch(() => undefined);
            await started.server.close({
              reason: "gateway RPC tool/skill catalog proof complete",
            });
          }
        } finally {
          temp.env.restore();
        }
      }
    },
  );
});
