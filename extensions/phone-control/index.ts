// Phone Control plugin entrypoint registers its OpenClaw integration.
import { randomUUID } from "node:crypto";
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

type ArmGroup = "camera" | "screen" | "computer" | "writes" | "all";

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

type ArmStateFileV3 = {
  version: 3;
  generation: string;
  phase: "preparing" | "active";
  armedAtMs: number;
  expiresAtMs: number | null;
  group: ArmGroup;
  armedCommands: string[];
  addedToAllow: string[];
  removedFromDeny: string[];
  persistentAllows: string[];
};

type ArmStateFile = ArmStateFileV1 | ArmStateFileV2 | ArmStateFileV3;
type StoredArmState = { key: string; state: ArmStateFile };
type PhoneControlConfigView = {
  readonly gateway?: {
    readonly nodes?: {
      readonly allowCommands?: readonly string[];
      readonly denyCommands?: readonly string[];
    };
  };
};

const STATE_VERSION = 3;
const ARM_STATE_NAMESPACE = "armed";
const PHONE_ADMIN_SCOPE = "operator.admin";
const PHONE_CONTROL_POLICY_DENIED = "PHONE_CONTROL_DISARMED";
const PHONE_CONTROL_POLICY_UNAVAILABLE = "PHONE_CONTROL_STATE_UNAVAILABLE";

const GROUP_COMMANDS: Record<Exclude<ArmGroup, "all">, string[]> = {
  camera: ["camera.snap", "camera.clip"],
  screen: ["screen.record"],
  // Desktop pointer/keyboard control on a paired macOS node.
  computer: ["computer.act"],
  writes: ["calendar.add", "contacts.add", "reminders.add", "sms.send"],
};
const PHONE_CONTROL_COMMANDS = Object.values(GROUP_COMMANDS).flat();
const LEGACY_ALL_GROUPS = ["camera", "screen", "writes"] as const;

function uniqSorted(values: string[]): string[] {
  return sortUniqueStrings(normalizeStringEntries(values));
}

function resolveCommandsForGroup(group: ArmGroup): string[] {
  if (group === "all") {
    // Keep the shipped `all` scope stable: desktop control always requires the
    // explicit `computer` group instead of arriving through an upgrade.
    return uniqSorted(LEGACY_ALL_GROUPS.flatMap((legacyGroup) => GROUP_COMMANDS[legacyGroup]));
  }
  return uniqSorted(GROUP_COMMANDS[group]);
}

function formatGroupList(): string {
  return ["camera", "screen", "computer", "writes", "all"].join(", ");
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
    overflowPolicy: "reject-new",
  });
}

async function readStoredArmState(api: OpenClawPluginApi): Promise<StoredArmState | null> {
  const entries = await openArmStateStore(api).entries();
  if (entries.length === 0) {
    return null;
  }
  if (entries.length !== 1) {
    throw new Error("phone-control: arm state contains multiple lease records");
  }
  const entry = entries[0];
  if (!entry) {
    return null;
  }
  return { key: entry.key, state: entry.value };
}

async function readArmState(api: OpenClawPluginApi): Promise<ArmStateFile | null> {
  return (await readStoredArmState(api))?.state ?? null;
}

async function registerArmState(api: OpenClawPluginApi, state: ArmStateFileV3): Promise<void> {
  await openArmStateStore(api).register(state.generation, state);
}

async function activateArmState(
  api: OpenClawPluginApi,
  preparing: ArmStateFileV3,
): Promise<boolean> {
  const store = openArmStateStore(api);
  if (!store.update) {
    throw new Error("phone-control: atomic arm-state update is unavailable");
  }
  return await store.update(preparing.generation, (current) => {
    if (
      current?.version !== STATE_VERSION ||
      current.generation !== preparing.generation ||
      current.phase !== "preparing"
    ) {
      return undefined;
    }
    return { ...preparing, phase: "active" };
  });
}

async function consumeArmState(api: OpenClawPluginApi, expected: StoredArmState): Promise<boolean> {
  const consumed = await openArmStateStore(api).consume(expected.key);
  if (!consumed) {
    return false;
  }
  if (
    expected.state.version === STATE_VERSION &&
    (consumed.version !== STATE_VERSION || consumed.generation !== expected.state.generation)
  ) {
    throw new Error("phone-control: arm-state generation changed during cleanup");
  }
  return true;
}

function normalizeDenyList(cfg: PhoneControlConfigView): string[] {
  return uniqSorted([...(cfg.gateway?.nodes?.denyCommands ?? [])]);
}

function normalizeAllowList(cfg: PhoneControlConfigView): string[] {
  return uniqSorted([...(cfg.gateway?.nodes?.allowCommands ?? [])]);
}

function resolveEffectivePhoneControlAllows(params: {
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
}): string[] {
  return uniqSorted(
    PHONE_CONTROL_COMMANDS.filter(
      (command) => params.allow.has(command) && !params.deny.has(command),
    ),
  );
}

function resolvePersistentEffectivePhoneControlAllows(
  cfg: PhoneControlConfigView,
  state: ArmStateFile | null,
): string[] {
  const effective = resolveEffectivePhoneControlAllows({
    allow: new Set(normalizeAllowList(cfg)),
    deny: new Set(normalizeDenyList(cfg)),
  });
  if (!state) {
    return effective;
  }
  if (state.version === STATE_VERSION) {
    const persistent = new Set(state.persistentAllows);
    return effective.filter((command) => persistent.has(command));
  }
  const temporary = new Set([
    ...(state.version === 2 ? state.addedToAllow : []),
    ...state.removedFromDeny,
  ]);
  return effective.filter((command) => !temporary.has(command));
}

function resolveArmStateCommands(state: ArmStateFile): string[] {
  if (state.version === 1) {
    return uniqSorted(state.removedFromDeny);
  }
  return uniqSorted(
    state.armedCommands.length > 0
      ? state.armedCommands
      : [...state.addedToAllow, ...state.removedFromDeny],
  );
}

function isArmStatePreparing(state: ArmStateFile): boolean {
  return state.version === STATE_VERSION && state.phase === "preparing";
}

function isCommandEffectivelyAllowed(cfg: PhoneControlConfigView, command: string): boolean {
  const allow = new Set(normalizeAllowList(cfg));
  const deny = new Set(normalizeDenyList(cfg));
  return allow.has(command) && !deny.has(command);
}

function formatPersistentAllows(commands: readonly string[]): string | null {
  if (commands.length === 0) {
    return null;
  }
  return `Persistent gateway allows (remain active after /phone disarm): ${commands.join(", ")}`;
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
  expectedKey?: string;
  fallbackState?: ArmStateFileV3;
}): Promise<{
  changed: boolean;
  restored: string[];
  removed: string[];
  persistentlyAllowed: string[];
}> {
  const { api, reason } = params;
  const stored = await readStoredArmState(api);
  const currentConfig = api.runtime.config.current();
  const matchingStored =
    stored !== null && (params.expectedKey === undefined || stored.key === params.expectedKey)
      ? stored
      : null;
  const fallbackMatchesExpected =
    stored === null &&
    params.expectedKey !== undefined &&
    params.fallbackState?.generation === params.expectedKey;
  if (!matchingStored && !fallbackMatchesExpected) {
    return {
      changed: false,
      restored: [],
      removed: [],
      persistentlyAllowed: resolveEffectivePhoneControlAllows({
        allow: new Set(normalizeAllowList(currentConfig)),
        deny: new Set(normalizeDenyList(currentConfig)),
      }),
    };
  }
  // Activation can discover that its preparing journal disappeared only after
  // the config commit. The locally held journal is then the sole cleanup delta.
  const state = matchingStored?.state ?? params.fallbackState;
  if (!state) {
    throw new Error("phone-control: missing arm-state cleanup journal");
  }
  const removed: string[] = [];
  const restored: string[] = [];
  let finalAllow = normalizeAllowList(currentConfig);
  let finalDeny = normalizeDenyList(currentConfig);
  const addedToAllow = state.version === 1 ? [] : state.addedToAllow;
  const hasConfigDelta = addedToAllow.length > 0 || state.removedFromDeny.length > 0;

  if (hasConfigDelta) {
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const allow = new Set(normalizeAllowList(draft));
        const deny = new Set(normalizeDenyList(draft));
        for (const cmd of addedToAllow) {
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
        finalAllow = uniqSorted([...allow]);
        finalDeny = uniqSorted([...deny]);
        const next = patchConfigNodeLists(draft, {
          allowCommands: finalAllow,
          denyCommands: finalDeny,
        });
        Object.assign(draft, next);
      },
    });
  }
  if (matchingStored && !(await consumeArmState(api, matchingStored))) {
    throw new Error("phone-control: arm state changed before cleanup completed");
  }
  api.logger.info(`phone-control: disarmed (${reason})`);
  return {
    changed: removed.length > 0 || restored.length > 0,
    removed: uniqSorted(removed),
    restored: uniqSorted(restored),
    persistentlyAllowed: resolveEffectivePhoneControlAllows({
      allow: new Set(finalAllow),
      deny: new Set(finalDeny),
    }),
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
    "- This only toggles what the gateway is allowed to invoke on paired nodes.",
    "- iOS will still ask for permissions (camera, photos, contacts, etc.) on first use.",
    "- all keeps its legacy camera/screen/writes scope; desktop control requires",
    "  an explicit /phone arm computer.",
    "- computer: desktop pointer/keyboard control on a paired macOS node; the Mac",
    "  app still requires Computer Control enabled plus Accessibility permission.",
  ].join("\n");
}

function parseGroup(raw: string | undefined): ArmGroup | null {
  const value = normalizeOptionalLowercaseString(raw) ?? "";
  if (!value) {
    return null;
  }
  if (
    value === "camera" ||
    value === "screen" ||
    value === "computer" ||
    value === "writes" ||
    value === "all"
  ) {
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

function formatStatus(state: ArmStateFile | null, cfg: PhoneControlConfigView): string {
  const persistentLine = formatPersistentAllows(
    resolvePersistentEffectivePhoneControlAllows(cfg, state),
  );
  if (!state) {
    return ["Phone control: disarmed.", persistentLine].filter(Boolean).join("\n");
  }
  if (isArmStatePreparing(state)) {
    const commands = resolveArmStateCommands(state);
    return [
      "Phone control: reconciling (temporary commands unavailable).",
      `Pending scope: ${commands.length > 0 ? commands.join(", ") : "none"}`,
      persistentLine,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const until = resolveArmExpiryStatus(state);
  const cmds = resolveArmStateCommands(state);
  const cmdLabel = cmds.length > 0 ? cmds.join(", ") : "none";
  const commandLabel = persistentLine ? "Arm scope" : "Temporarily allowed";
  return [`Phone control: armed (${until}).`, `${commandLabel}: ${cmdLabel}`, persistentLine]
    .filter(Boolean)
    .join("\n");
}

export default definePluginEntry({
  id: "phone-control",
  name: "Phone Control",
  description: "Temporary allowlist control for phone automation commands",
  register(api: OpenClawPluginApi) {
    let expiryInterval: ReturnType<typeof setInterval> | null = null;
    let initialExpiryTick: ReturnType<typeof setImmediate> | null = null;
    let acceptingLeaseMutations = true;
    let leaseMutationTail: Promise<void> = Promise.resolve();

    const serializeLeaseMutation = <T>(run: () => Promise<T>): Promise<T> => {
      if (!acceptingLeaseMutations) {
        return Promise.reject(new Error("phone-control: lease owner is stopping"));
      }
      const result = leaseMutationTail.then(run, run);
      leaseMutationTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const disarmLease = async (params: {
      reason: string;
      expectedKey?: string;
      fallbackState?: ArmStateFileV3;
    }) =>
      await disarmNow({
        api,
        ...params,
      });

    const reconcileLease = async (reason: string): Promise<void> => {
      const stored = await readStoredArmState(api);
      if (!stored) {
        return;
      }
      if (!isArmStatePreparing(stored.state) && !isArmStateExpired(stored.state)) {
        return;
      }
      await disarmLease({ reason, expectedKey: stored.key });
    };

    const logReconcileFailure = (reason: string, err: unknown) => {
      api.logger.warn(`phone-control: ${reason} reconciliation failed: ${String(err)}`);
    };

    const timerService: OpenClawPluginService = {
      id: "phone-control-expiry",
      start: async (ctx) => {
        const tick = async () =>
          await serializeLeaseMutation(async () => await reconcileLease("expired"));

        expiryInterval = setInterval(() => {
          tick().catch((err: unknown) => logReconcileFailure("expiry", err));
        }, 15_000);
        expiryInterval.unref?.();

        if (hasPhoneControlAllowOverride(ctx.config)) {
          // Active dangerous command allows must be reconciled before gateway
          // service startup completes. The computer node-invoke policy remains
          // fail-closed if this best-effort cleanup cannot read or write state.
          await tick().catch((err: unknown) => logReconcileFailure("startup", err));
        } else {
          // With no active phone-control allowlist, startup can avoid opening
          // plugin state before readiness; cleanup still runs before the interval.
          initialExpiryTick = setImmediate(() => {
            initialExpiryTick = null;
            tick().catch((err: unknown) => logReconcileFailure("initial expiry", err));
          });
          initialExpiryTick.unref?.();
        }
      },
      stop: async () => {
        // Close admission before observing the tail. Otherwise an old handler can
        // enqueue behind the captured promise and mutate a newer reload generation.
        acceptingLeaseMutations = false;
        if (initialExpiryTick) {
          clearImmediate(initialExpiryTick);
          initialExpiryTick = null;
        }
        if (expiryInterval) {
          clearInterval(expiryInterval);
          expiryInterval = null;
        }
        // Plugin reload installs a new lease owner. Drain the old instance first
        // so an in-flight expiry cannot clean up the newer generation afterward.
        await leaseMutationTail;
      },
    };

    api.registerService(timerService);

    // Existing phone commands remain core-owned protocol surfaces. Registering
    // policies for them would hide those commands from N-1 nodes, while the new
    // computer surface can safely bind its temporary lease to this final
    // pre-dispatch gate.
    api.registerNodeInvokePolicy({
      commands: [...GROUP_COMMANDS.computer],
      handle: async (ctx) => {
        let allowed: boolean;
        try {
          allowed = await serializeLeaseMutation(async () => {
            await reconcileLease("dispatch");
            const state = await readArmState(api);
            const cfg = api.runtime.config.current();
            if (!isCommandEffectivelyAllowed(cfg, ctx.command)) {
              return false;
            }
            if (!state) {
              // With no lease journal, an effective explicit config entry is an
              // operator-authored persistent grant.
              return true;
            }
            if (resolvePersistentEffectivePhoneControlAllows(cfg, state).includes(ctx.command)) {
              return true;
            }
            return (
              !isArmStatePreparing(state) &&
              !isArmStateExpired(state) &&
              resolveArmStateCommands(state).includes(ctx.command)
            );
          });
        } catch (err) {
          logReconcileFailure("computer dispatch", err);
          return {
            ok: false,
            code: PHONE_CONTROL_POLICY_UNAVAILABLE,
            message: `phone-control: ${ctx.command} lease state is unavailable`,
            unavailable: true,
          };
        }
        if (!allowed) {
          return {
            ok: false,
            code: PHONE_CONTROL_POLICY_DENIED,
            message: `phone-control: ${ctx.command} is not covered by an active temporary lease or persistent gateway allow`,
          };
        }
        // The core transport wrapper rechecks the current config/route at the
        // actual dispatch boundary. Keep it outside the lease mutex so an
        // unresponsive node cannot block expiry or manual disarm.
        return await ctx.invokeNode();
      },
    });

    api.registerCommand({
      name: "phone",
      description: "Arm/disarm high-risk node commands (camera/screen/computer/writes).",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0]);

        if (!action || action === "help") {
          const state = await serializeLeaseMutation(async () => await readArmState(api));
          return {
            text: `${formatStatus(state, api.runtime.config.current())}\n\n${formatHelp()}`,
          };
        }

        if (action === "status") {
          const state = await serializeLeaseMutation(async () => await readArmState(api));
          return { text: formatStatus(state, api.runtime.config.current()) };
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
          const res = await serializeLeaseMutation(
            async () => await disarmLease({ reason: "manual" }),
          );
          const persistentLine = formatPersistentAllows(res.persistentlyAllowed);
          if (!res.changed && !persistentLine) {
            return { text: "Phone control: disarmed." };
          }
          const restoredLabel = res.restored.length > 0 ? res.restored.join(", ") : "none";
          const removedLabel = res.removed.length > 0 ? res.removed.join(", ") : "none";
          return {
            text: [
              "Phone control: disarmed.",
              `Removed allowlist: ${removedLabel}`,
              `Restored denylist: ${restoredLabel}`,
              persistentLine,
            ]
              .filter(Boolean)
              .join("\n"),
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

          return await serializeLeaseMutation(async () => {
            // Close the previous lease before opening another. This avoids a
            // single-row replacement ever losing the prior cleanup deltas.
            await disarmLease({ reason: "rearmed" });

            const commands = resolveCommandsForGroup(group);
            const generation = randomUUID();
            let preparingState: ArmStateFileV3 | undefined;
            let configCommitCompleted = false;
            try {
              await api.runtime.config.mutateConfigFile({
                afterWrite: { mode: "auto" },
                mutate: async (draft) => {
                  // Derive from the transaction's fresh draft, not the process
                  // snapshot read before waiting for the config-file lock.
                  const allow = new Set(normalizeAllowList(draft));
                  const deny = new Set(normalizeDenyList(draft));
                  const persistentAllows = resolveEffectivePhoneControlAllows({ allow, deny });
                  const addedToAllow: string[] = [];
                  const removedFromDeny: string[] = [];
                  for (const cmd of commands) {
                    if (!allow.has(cmd)) {
                      allow.add(cmd);
                      addedToAllow.push(cmd);
                    }
                    if (deny.delete(cmd)) {
                      removedFromDeny.push(cmd);
                    }
                  }
                  preparingState = {
                    version: STATE_VERSION,
                    generation,
                    phase: "preparing",
                    armedAtMs,
                    expiresAtMs,
                    group,
                    armedCommands: uniqSorted(commands),
                    addedToAllow: uniqSorted(addedToAllow),
                    removedFromDeny: uniqSorted(removedFromDeny),
                    persistentAllows,
                  };
                  // SQLite owns the cleanup journal before the config file can
                  // expose a temporary command. A failed write leaves no grant.
                  await registerArmState(api, preparingState);
                  const next = patchConfigNodeLists(draft, {
                    allowCommands: uniqSorted([...allow]),
                    denyCommands: uniqSorted([...deny]),
                  });
                  Object.assign(draft, next);
                },
              });
              configCommitCompleted = true;

              const prepared = preparingState;
              if (!prepared) {
                throw new Error("phone-control: config mutation did not prepare an arm lease");
              }
              if (!(await activateArmState(api, prepared))) {
                throw new Error("phone-control: prepared arm lease changed before activation");
              }
            } catch (err) {
              if (preparingState) {
                try {
                  await disarmLease({
                    reason: "arm failed",
                    expectedKey: preparingState.generation,
                    // The local delta is needed only after the config commit.
                    // Before then, a matching SQLite journal owns cleanup.
                    fallbackState: configCommitCompleted ? preparingState : undefined,
                  });
                } catch (cleanupError) {
                  throw new Error(
                    `phone-control: arm failed and cleanup could not complete: ${String(err)}`,
                    { cause: cleanupError },
                  );
                }
              }
              throw new Error("phone-control: failed to persist temporary arm lease", {
                cause: err,
              });
            }

            const allowedLabel = uniqSorted(commands).join(", ");
            return {
              text:
                `Phone control: armed for ${formatDuration(durationMs)}.\n` +
                `Temporarily allowed: ${allowedLabel}\n` +
                `To disarm early: /phone disarm`,
            };
          });
        }

        return { text: formatHelp() };
      },
    });
  },
});
