// Dev gateway bootstrap for a local loopback config and seeded dev workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { resolveWorkspaceTemplateSearchDirs } from "../../agents/workspace-templates.js";
import { publishBootstrapFile, resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { handleReset } from "../../commands/onboard-helpers.js";
import { createConfigIO, replaceConfigFile } from "../../config/config.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath, shortenHomePath } from "../../utils.js";

const DEV_IDENTITY_NAME = "C3-PO";
const DEV_IDENTITY_THEME = "protocol droid";
const DEV_IDENTITY_EMOJI = "🤖";
const DEV_AGENT_WORKSPACE_SUFFIX = "dev";

async function loadDevTemplate(name: string, fallback: string): Promise<string> {
  // Template frontmatter is metadata only; workspace files receive the body content.
  try {
    const templateDirs = await resolveWorkspaceTemplateSearchDirs();
    for (const templateDir of templateDirs) {
      let raw: string;
      try {
        raw = await fs.promises.readFile(path.join(templateDir, name), "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      return extractFrontmatterBlock(raw)?.body.replace(/^\s+/, "") ?? raw;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

const resolveDevWorkspaceDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const baseDir = resolveDefaultAgentWorkspaceDir(env, os.homedir);
  const profile = normalizeOptionalLowercaseString(env.OPENCLAW_PROFILE);
  if (profile === "dev") {
    return baseDir;
  }
  return `${baseDir}-${DEV_AGENT_WORKSPACE_SUFFIX}`;
};

async function ensureDevWorkspace(dir: string) {
  const resolvedDir = resolveUserPath(dir);
  await fs.promises.mkdir(resolvedDir, { recursive: true });

  const [agents, soul, identity, user] = await Promise.all([
    loadDevTemplate(
      "AGENTS.dev.md",
      `# AGENTS.md - OpenClaw Dev Workspace\n\nDefault dev workspace for openclaw gateway --dev.\n`,
    ),
    loadDevTemplate(
      "SOUL.dev.md",
      `# SOUL.md - Dev Persona\n\nProtocol droid for debugging and operations.\n`,
    ),
    loadDevTemplate(
      "IDENTITY.dev.md",
      `# IDENTITY.md - Agent Identity\n\n- Name: ${DEV_IDENTITY_NAME}\n- Creature: protocol droid\n- Vibe: ${DEV_IDENTITY_THEME}\n- Emoji: ${DEV_IDENTITY_EMOJI}\n`,
    ),
    loadDevTemplate(
      "USER.dev.md",
      `# USER.md - User Profile\n\n- Name:\n- Preferred address:\n- Notes:\n`,
    ),
  ]);

  await publishBootstrapFile(path.join(resolvedDir, "AGENTS.md"), agents);
  await publishBootstrapFile(path.join(resolvedDir, "SOUL.md"), soul);
  await publishBootstrapFile(path.join(resolvedDir, "IDENTITY.md"), identity);
  await publishBootstrapFile(path.join(resolvedDir, "USER.md"), user);
}

export async function ensureDevGatewayConfig(opts: { reset?: boolean }) {
  const workspace = resolveDevWorkspaceDir();
  if (opts.reset) {
    await handleReset("full", workspace, defaultRuntime);
  }

  const io = createConfigIO();
  const configPath = io.configPath;
  const configExists = fs.existsSync(configPath);
  if (!opts.reset && configExists) {
    return;
  }

  await ensureDevWorkspace(workspace);
  await replaceConfigFile({
    nextConfig: {
      gateway: {
        mode: "local",
        bind: "loopback",
      },
      agents: {
        defaults: {
          workspace,
          skipBootstrap: true,
        },
        entries: {
          dev: {
            default: true,
            workspace,
            identity: {
              name: DEV_IDENTITY_NAME,
              theme: DEV_IDENTITY_THEME,
              emoji: DEV_IDENTITY_EMOJI,
            },
          },
        },
      },
    },
    afterWrite: { mode: "auto" },
    // An absent config resolves to the implicit legacy agent before this full
    // replacement. Declare only that synthetic deletion; authored rosters stay protected.
    writeOptions: { allowedAgentRosterRemovals: [LEGACY_IMPLICIT_AGENT_ID] },
  });
  defaultRuntime.log(`Dev config ready: ${shortenHomePath(configPath)}`);
  defaultRuntime.log(`Dev workspace ready: ${shortenHomePath(resolveUserPath(workspace))}`);
}
