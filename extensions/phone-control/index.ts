import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginService,
} from "./runtime-api.js";

type ArmGroup = "camera" | "screen" | "writes" | "all";

type ArmStateFileV1 = {
  version: 1;
  armedAtMs: number;
  expiresAtMs: number | null;
  removedFromDeny: string[];
};

type ArmStateFileV2 = {
  version: 2;
  armedAtMs: number;
  expiresAtMs: number | null;
  group: ArmGroup;
  armedCommands: string[];
  addedToAllow: string[];
  removedFromDeny: string[];
};

type ArmStateFile = ArmStateFileV1 | ArmStateFileV2;

const STATE_VERSION = 2;
const STATE_REL_PATH = ["plugins", "phone-control", "armed.json"] as const;
const PHONE_ADMIN_SCOPE = "operator.admin";

const GROUP_COMMANDS: Record<Exclude<ArmGroup, "all">, string[]> = {
  camera: ["camera.snap", "camera.clip"],
  screen: ["screen.record"],
  writes: ["calendar.add", "contacts.add", "reminders.add", "sms.send"],
};

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].toSorted();
}

function resolveCommandsForGroup(group: ArmGroup): string[] {
  if (group === "all") {
    return uniqSorted(Object.values(GROUP_COMMANDS).flat());
  }
  return uniqSorted(GROUP_COMMANDS[group]);
}

function formatGroupList(): string {
  return ["camera", "screen", "writes", "all"].join(", ");
}

function parseDurationMs(input: string | undefined): number | null {
  const raw = normalizeOptionalLowercaseString(input);
  if (!raw) {
    return null;
  }
  const m = raw.match(/^(\d+)(s|m|h|d)$/);
  if (!m) {
    return null;
  }
  const n = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function resolveStatePath(stateDir: string): string {
  return path.join(stateDir, ...STATE_REL_PATH);
}

async function readArmState(statePath: string): Promise<ArmStateFile | null> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    // Type as unknown record first to allow property access during validation
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 && parsed.version !== 2) {
      return null;
    }
    if (typeof parsed.armedAtMs !== "number") {
      return null;
    }
    if (!(parsed.expiresAtMs === null || typeof parsed.expiresAtMs === "number")) {
      return null;
    }

    if (parsed.version === 1) {
      if (
        !Array.isArray(parsed.removedFromDeny) ||
        !parsed.removedFromDeny.every((v: unknown) => typeof v === "string")
      ) {
        return null;
      }
      return parsed as unknown as ArmStateFile;
    }

    const group = typeof parsed.group === "string" ? parsed.group : "";
    if (group !== "camera" && group !== "screen" && group !== "writes" && group !== "all") {
      return null;
    }
    if (
      !Array.isArray(parsed.armedCommands) ||
      !parsed.armedCommands.every((v: unknown) => typeof v === "string")
    ) {
      return null;
    }
    if (
      !Array.isArray(parsed.addedToAllow) ||
      !parsed.addedToAllow.every((v: unknown) => typeof v === "string")
    ) {
      return null;
    }
    if (
      !Array.isArray(parsed.removedFromDeny) ||
      !parsed.removedFromDeny.every((v: unknown) => typeof v === "string")
    ) {
      return null;
    }
    return parsed as unknown as ArmStateFile;
  } catch {
    return null;
  }
}

async function writeArmState(statePath: string, state: ArmStateFile | null): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  if (!state) {
    try {
      await fs.unlink(statePath);
    } catch {
      // ignore
    }
    return;
  }
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeDenyList(cfg: OpenClawPluginApi["config"]): string[] {
  return uniqSorted([...(cfg.gateway?.nodes?.denyCommands ?? [])]);
}

function normalizeAllowList(cfg: OpenClawPluginApi["config"]): string[] {
  return uniqSorted([...(cfg.gateway?.nodes?.allowCommands ?? [])]);
}

function patchConfigNodeLists(
  cfg: OpenClawPluginApi["config"],
  next: { allowCommands: string[]; denyCommands: string[] },
): OpenClawPluginApi["config"] {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...cfg.gateway?.nodes,
        allowCommands: next.allowCommands,
        denyCommands: next.denyCommands,
      },
    },
  };
}

async function disarmNow(params: {
  api: OpenClawPluginApi;
  stateDir: string;
  statePath: string;
  reason: string;
}): Promise<{ changed: boolean; restored: string[]; removed: string[] }> {
  const { api, stateDir, statePath, reason } = params;
  const state = await readArmState(statePath);
  if (!state) {
    return { changed: false, restored: [], removed: [] };
  }
  const cfg = api.runtime.config.current() as OpenClawConfig;
  const allow = new Set(normalizeAllowList(cfg));
  const deny = new Set(normalizeDenyList(cfg));
  const removed: string[] = [];
  const restored: string[] = [];

  if (state.version === 1) {
    for (const cmd of state.removedFromDeny) {
      if (!deny.has(cmd)) {
        deny.add(cmd);
        restored.push(cmd);
      }
    }
  } else {
    for (const cmd of state.addedToAllow) {
      if (allow.delete(cmd)) {
        removed.push(cmd);
      }
    }
    for (const cmd of state.removedFromDeny) {
      if (!deny.has(cmd)) {
        deny.add(cmd);
        restored.push(cmd);
      }
    }
  }

  if (removed.length > 0 || restored.length > 0) {
    const next = patchConfigNodeLists(cfg, {
      allowCommands: uniqSorted([...allow]),
      denyCommands: uniqSorted([...deny]),
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: next,
      afterWrite: { mode: "auto" },
    });
  }
  await writeArmState(statePath, null);
  api.logger.info(`phone-control: disarmed (${reason}) stateDir=${stateDir}`);
  return {
    changed: removed.length > 0 || restored.length > 0,
    removed: uniqSorted(removed),
    restored: uniqSorted(restored),
  };
}

function formatHelp(): string {
  return [
    "Phone control commands:",
    "",
    "/phone status",
    "/phone arm <group> [duration]",
    "/phone disarm",
    "",
    "Groups:",
    `- ${formatGroupList()}`,
    "",
    "Duration format: 30s | 10m | 2h | 1d (default: 10m).",
    "",
    "Notes:",
    "- This only toggles what the gateway is allowed to invoke on phone nodes.",
    "- iOS will still ask for permissions (camera, photos, contacts, etc.) on first use.",
  ].join("\n");
}

function parseGroup(raw: string | undefined): ArmGroup | null {
  const value = normalizeOptionalLowercaseString(raw) ?? "";
  if (!value) {
    return null;
  }
  if (value === "camera" || value === "screen" || value === "writes" || value === "all") {
    return value;
  }
  return null;
}

function requiresAdminToMutatePhoneControl(
  channel: string,
  gatewayClientScopes?: readonly string[],
): boolean {
  if (Array.isArray(gatewayClientScopes)) {
    return !gatewayClientScopes.includes(PHONE_ADMIN_SCOPE);
  }
  return channel === "webchat";
}

function formatStatus(state: ArmStateFile | null): string {
  if (!state) {
    return "Phone control: disarmed.";
  }
  const until =
    state.expiresAtMs == null
      ? "manual disarm required"
      : `expires in ${formatDuration(Math.max(0, state.expiresAtMs - Date.now()))}`;
  const cmds = uniqSorted(
    state.version === 1
      ? state.removedFromDeny
      : state.armedCommands.length > 0
        ? state.armedCommands
        : [...state.addedToAllow, ...state.removedFromDeny],
  );
  const cmdLabel = cmds.length > 0 ? cmds.join(", ") : "none";
  return `Phone control: armed (${until}).\nTemporarily allowed: ${cmdLabel}`;
}

export default definePluginEntry({
  id: "phone-control",
  name: "Phone Control",
  description: "Temporary allowlist control for phone automation commands",
  register(api: OpenClawPluginApi) {
    let expiryInterval: ReturnType<typeof setInterval> | null = null;

    const timerService: OpenClawPluginService = {
      id: "phone-control-expiry",
      start: async (ctx) => {
        const statePath = resolveStatePath(ctx.stateDir);
        const tick = async () => {
          const state = await readArmState(statePath);
          if (!state || state.expiresAtMs == null) {
            return;
          }
          if (Date.now() < state.expiresAtMs) {
            return;
          }
          await disarmNow({
            api,
            stateDir: ctx.stateDir,
            statePath,
            reason: "expired",
          });
        };

        // Best effort; don't crash the gateway if state is corrupt.
        await tick().catch(() => {});

        expiryInterval = setInterval(() => {
          tick().catch(() => {});
        }, 15_000);
        expiryInterval.unref?.();

        return;
      },
      stop: async () => {
        if (expiryInterval) {
          clearInterval(expiryInterval);
          expiryInterval = null;
        }
        return;
      },
    };

    api.registerService(timerService);

    api.registerCommand({
      name: "phone",
      description: "Arm/disarm high-risk phone node commands (camera/screen/writes).",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0]);

        const stateDir = api.runtime.state.resolveStateDir();
        const statePath = resolveStatePath(stateDir);

        if (!action || action === "help") {
          const state = await readArmState(statePath);
          return { text: `${formatStatus(state)}\n\n${formatHelp()}` };
        }

        if (action === "status") {
          const state = await readArmState(statePath);
          return { text: formatStatus(state) };
        }

        if (action === "disarm") {
          if (requiresAdminToMutatePhoneControl(ctx.channel, ctx.gatewayClientScopes)) {
            return {
              text: "⚠️ /phone disarm requires operator.admin.",
            };
          }
          const res = await disarmNow({
            api,
            stateDir,
            statePath,
            reason: "manual",
          });
          if (!res.changed) {
            return { text: "Phone control: disarmed." };
          }
          const restoredLabel = res.restored.length > 0 ? res.restored.join(", ") : "none";
          const removedLabel = res.removed.length > 0 ? res.removed.join(", ") : "none";
          return {
            text: `Phone control: disarmed.\nRemoved allowlist: ${removedLabel}\nRestored denylist: ${restoredLabel}`,
          };
        }

        if (action === "arm") {
          if (requiresAdminToMutatePhoneControl(ctx.channel, ctx.gatewayClientScopes)) {
            return {
              text: "⚠️ /phone arm requires operator.admin.",
            };
          }
          const group = parseGroup(tokens[1]);
          if (!group) {
            return { text: `Usage: /phone arm <group> [duration]\nGroups: ${formatGroupList()}` };
          }
          const durationMs = parseDurationMs(tokens[2]) ?? 10 * 60_000;
          const expiresAtMs = Date.now() + durationMs;

          const commands = resolveCommandsForGroup(group);
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const allowSet = new Set(normalizeAllowList(cfg));
          const denySet = new Set(normalizeDenyList(cfg));

          const addedToAllow: string[] = [];
          const removedFromDeny: string[] = [];
          for (const cmd of commands) {
            if (!allowSet.has(cmd)) {
              allowSet.add(cmd);
              addedToAllow.push(cmd);
            }
            if (denySet.delete(cmd)) {
              removedFromDeny.push(cmd);
            }
          }
          const next = patchConfigNodeLists(cfg, {
            allowCommands: uniqSorted([...allowSet]),
            denyCommands: uniqSorted([...denySet]),
          });
          await api.runtime.config.replaceConfigFile({
            nextConfig: next,
            afterWrite: { mode: "auto" },
          });

          await writeArmState(statePath, {
            version: STATE_VERSION,
            armedAtMs: Date.now(),
            expiresAtMs,
            group,
            armedCommands: uniqSorted(commands),
            addedToAllow: uniqSorted(addedToAllow),
            removedFromDeny: uniqSorted(removedFromDeny),
          });

          const allowedLabel = uniqSorted(commands).join(", ");
          return {
            text:
              `Phone control: armed for ${formatDuration(durationMs)}.\n` +
              `Temporarily allowed: ${allowedLabel}\n` +
              `To disarm early: /phone disarm`,
          };
        }

        return { text: formatHelp() };
      },
    });
  },
});
