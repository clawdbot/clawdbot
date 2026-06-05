// Phone Control plugin entrypoint registers its OpenClaw integration.
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeStringEntries,
  sortUniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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
type PhoneControlConfigView = {
  readonly gateway?: {
    readonly nodes?: {
      readonly allowCommands?: readonly string[];
      readonly denyCommands?: readonly string[];
    };
  };
};

const STATE_VERSION = 2;
const ARM_STATE_NAMESPACE = "armed";
const ARM_STATE_KEY = "current";
const PHONE_ADMIN_SCOPE = "operator.admin";

const GROUP_COMMANDS: Record<Exclude<ArmGroup, "all">, string[]> = {
  camera: ["camera.snap", "camera.clip"],
  screen: ["screen.record"],
  writes: ["calendar.add", "contacts.add", "reminders.add", "sms.send"],
};
const PHONE_CONTROL_COMMANDS = Object.values(GROUP_COMMANDS).flat();

function uniqSorted(values: string[]): string[] {
  return sortUniqueStrings(normalizeStringEntries(values));
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
  const durationMs = n * mult;
  return Number.isSafeInteger(durationMs) ? durationMs : null;
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

function openArmStateStore(api: OpenClawPluginApi) {
  return api.runtime.state.openKeyedStore<ArmStateFile>({
    namespace: ARM_STATE_NAMESPACE,
    maxEntries: 1,
  });
}

async function readArmState(api: OpenClawPluginApi): Promise<ArmStateFile | null> {
  return (await openArmStateStore(api).lookup(ARM_STATE_KEY)) ?? null;
}

async function writeArmState(api: OpenClawPluginApi, state: ArmStateFile | null): Promise<void> {
  const store = openArmStateStore(api);
  if (!state) {
    await store.delete(ARM_STATE_KEY);
    return;
  }
  await store.register(ARM_STATE_KEY, state);
}

function normalizeDenyList(cfg: PhoneControlConfigView): string[] {
  return uniqSorted([...(cfg.gateway?.nodes?.denyCommands ?? [])]);
}

function normalizeAllowList(cfg: PhoneControlConfigView): string[] {
  return uniqSorted([...(cfg.gateway?.nodes?.allowCommands ?? [])]);
}

function hasPhoneControlAllowOverride(cfg: PhoneControlConfigView): boolean {
  const allow = new Set(normalizeAllowList(cfg));
  return PHONE_CONTROL_COMMANDS.some((cmd) => allow.has(cmd));
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
  reason: string;
}): Promise<{ changed: boolean; restored: string[]; removed: string[] }> {
  const { api, reason } = params;
  const state = await readArmState(api);
  if (!state) {
    return { changed: false, restored: [], removed: [] };
  }
  const cfg = api.runtime.config.current();
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
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const next = patchConfigNodeLists(draft, {
          allowCommands: uniqSorted([...allow]),
          denyCommands: uniqSorted([...deny]),
        });
        Object.assign(draft, next);
      },
    });
  }
  await writeArmState(api, null);
  api.logger.info(`phone-control: disarmed (${reason})`);
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

function lacksAdminToMutatePhoneControl(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): boolean {
  const { senderIsOwner, gatewayClientScopes } = params;
  if (Array.isArray(gatewayClientScopes)) {
    return !gatewayClientScopes.includes(PHONE_ADMIN_SCOPE);
  }
  return senderIsOwner !== true;
}

function resolveArmExpiryStatus(state: ArmStateFile, nowRaw = Date.now()): string {
  if (state.expiresAtMs == null) {
    return "manual disarm required";
  }
  const now = asDateTimestampMs(nowRaw);
  if (now === undefined) {
    return "expiry unavailable";
  }
  const expiresAt = asDateTimestampMs(state.expiresAtMs);
  if (expiresAt === undefined || expiresAt <= now) {
    return "expired";
  }
  return `expires in ${formatDuration(expiresAt - now)}`;
}

function isArmStateExpired(state: ArmStateFile, nowRaw = Date.now()): boolean {
  if (state.expiresAtMs == null) {
    return false;
  }
  const now = asDateTimestampMs(nowRaw);
  if (now === undefined) {
    return false;
  }
  const expiresAt = asDateTimestampMs(state.expiresAtMs);
  return expiresAt === undefined || expiresAt <= now;
}

function formatStatus(state: ArmStateFile | null): string {
  if (!state) {
    return "Phone control: disarmed.";
  }
  const until = resolveArmExpiryStatus(state);
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
    let initialExpiryTick: ReturnType<typeof setImmediate> | null = null;

    const timerService: OpenClawPluginService = {
      id: "phone-control-expiry",
      start: async (ctx) => {
        const tick = async () => {
          const state = await readArmState(api);
          if (!state || state.expiresAtMs == null) {
            return;
          }
          if (!isArmStateExpired(state)) {
            return;
          }
          await disarmNow({
            api,
            reason: "expired",
          });
        };

        expiryInterval = setInterval(() => {
          tick().catch(() => {});
        }, 15_000);
        expiryInterval.unref?.();

        if (hasPhoneControlAllowOverride(ctx.config)) {
          // Active dangerous command allows must be reconciled before gateway
          // readiness; otherwise an expired phone-control window can survive.
          await tick().catch(() => {});
        } else {
          // With no active phone-control allowlist, startup can avoid opening
          // plugin state before readiness; cleanup still runs before the interval.
          initialExpiryTick = setImmediate(() => {
            initialExpiryTick = null;
            tick().catch(() => {});
          });
          initialExpiryTick.unref?.();
        }
      },
      stop: async () => {
        if (initialExpiryTick) {
          clearImmediate(initialExpiryTick);
          initialExpiryTick = null;
        }
        if (expiryInterval) {
          clearInterval(expiryInterval);
          expiryInterval = null;
        }
      },
    };

    api.registerService(timerService);

    api.registerCommand({
      name: "phone",
      description: "Arm/disarm high-risk phone node commands (camera/screen/writes).",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0]);

        if (!action || action === "help") {
          const state = await readArmState(api);
          return { text: `${formatStatus(state)}\n\n${formatHelp()}` };
        }

        if (action === "status") {
          const state = await readArmState(api);
          return { text: formatStatus(state) };
        }

        if (action === "disarm") {
          if (
            lacksAdminToMutatePhoneControl({
              senderIsOwner: ctx.senderIsOwner,
              gatewayClientScopes: ctx.gatewayClientScopes,
            })
          ) {
            return {
              text: "⚠️ /phone disarm requires operator.admin.",
            };
          }
          const res = await disarmNow({
            api,
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
          if (
            lacksAdminToMutatePhoneControl({
              senderIsOwner: ctx.senderIsOwner,
              gatewayClientScopes: ctx.gatewayClientScopes,
            })
          ) {
            return {
              text: "⚠️ /phone arm requires operator.admin.",
            };
          }
          const group = parseGroup(tokens[1]);
          if (!group) {
            return { text: `Usage: /phone arm <group> [duration]\nGroups: ${formatGroupList()}` };
          }
          const durationMs = tokens[2] === undefined ? 10 * 60_000 : parseDurationMs(tokens[2]);
          if (durationMs === null) {
            return { text: "Invalid duration. Use values like 30s, 10m, 2h, or 1d." };
          }
          const armedAtMs = asDateTimestampMs(Date.now());
          const expiresAtMs =
            armedAtMs === undefined
              ? undefined
              : resolveExpiresAtMsFromDurationMs(durationMs, { nowMs: armedAtMs });
          if (armedAtMs === undefined || expiresAtMs === undefined) {
            return { text: "Invalid duration. Use values like 30s, 10m, 2h, or 1d." };
          }

          const commands = resolveCommandsForGroup(group);
          const cfg = api.runtime.config.current();
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
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              const next = patchConfigNodeLists(draft, {
                allowCommands: uniqSorted([...allowSet]),
                denyCommands: uniqSorted([...denySet]),
              });
              Object.assign(draft, next);
            },
          });

          await writeArmState(api, {
            version: STATE_VERSION,
            armedAtMs,
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
