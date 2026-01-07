import chokidar from "chokidar";

import type {
  ClawdbotConfig,
  ConfigFileSnapshot,
  GatewayReloadMode,
} from "../config/config.js";

export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

export type ProviderKind =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "matrix"
  | "signal"
  | "imessage";

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartBrowserControl: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartProviders: Set<ProviderKind>;
  noopPaths: string[];
};

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
};

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-browser-control"
  | "restart-cron"
  | "restart-heartbeat"
  | "restart-provider:whatsapp"
  | "restart-provider:telegram"
  | "restart-provider:discord"
  | "restart-provider:slack"
  | "restart-provider:matrix"
  | "restart-provider:signal"
  | "restart-provider:imessage";

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};

const RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  {
    prefix: "browser",
    kind: "hot",
    actions: ["restart-browser-control"],
  },
  { prefix: "web", kind: "hot", actions: ["restart-provider:whatsapp"] },
  { prefix: "telegram", kind: "hot", actions: ["restart-provider:telegram"] },
  { prefix: "discord", kind: "hot", actions: ["restart-provider:discord"] },
  { prefix: "slack", kind: "hot", actions: ["restart-provider:slack"] },
  { prefix: "matrix", kind: "hot", actions: ["restart-provider:matrix"] },
  { prefix: "signal", kind: "hot", actions: ["restart-provider:signal"] },
  { prefix: "imessage", kind: "hot", actions: ["restart-provider:imessage"] },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "models", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "whatsapp", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "bridge", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
  { prefix: "canvasHost", kind: "restart" },
];

function matchRule(path: string): ReloadRule | null {
  for (const rule of RELOAD_RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) return rule;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]",
  );
}

export function diffConfigPaths(
  prev: unknown,
  next: unknown,
  prefix = "",
): string[] {
  if (prev === next) return [];
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) continue;
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (
      prev.length === next.length &&
      prev.every((val, idx) => val === next[idx])
    ) {
      return [];
    }
  }
  return [prefix || "<root>"];
}

export function resolveGatewayReloadSettings(
  cfg: ClawdbotConfig,
): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" ||
    rawMode === "restart" ||
    rawMode === "hot" ||
    rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  const debounceRaw = cfg.gateway?.reload?.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(0, Math.floor(debounceRaw))
      : DEFAULT_RELOAD_SETTINGS.debounceMs;
  return { mode, debounceMs };
}

export function buildGatewayReloadPlan(
  changedPaths: string[],
): GatewayReloadPlan {
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartProviders: new Set(),
    noopPaths: [],
  };

  const applyAction = (action: ReloadAction) => {
    switch (action) {
      case "reload-hooks":
        plan.reloadHooks = true;
        break;
      case "restart-gmail-watcher":
        plan.restartGmailWatcher = true;
        break;
      case "restart-browser-control":
        plan.restartBrowserControl = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
        break;
      case "restart-provider:whatsapp":
        plan.restartProviders.add("whatsapp");
        break;
      case "restart-provider:telegram":
        plan.restartProviders.add("telegram");
        break;
      case "restart-provider:discord":
        plan.restartProviders.add("discord");
        break;
      case "restart-provider:slack":
        plan.restartProviders.add("slack");
        break;
      case "restart-provider:matrix":
        plan.restartProviders.add("matrix");
        break;
      case "restart-provider:signal":
        plan.restartProviders.add("signal");
        break;
      case "restart-provider:imessage":
        plan.restartProviders.add("imessage");
        break;
      default:
        break;
    }
  };

  for (const path of changedPaths) {
    const rule = matchRule(path);
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "restart") {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action);
    }
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}

export type GatewayConfigReloader = {
  stop: () => Promise<void>;
};

export function startGatewayConfigReloader(opts: {
  initialConfig: ClawdbotConfig;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onHotReload: (
    plan: GatewayReloadPlan,
    nextConfig: ClawdbotConfig,
  ) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: ClawdbotConfig) => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  let currentConfig = opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let restartQueued = false;

  const schedule = () => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const wait = settings.debounceMs;
    debounceTimer = setTimeout(() => {
      void runReload();
    }, wait);
  };

  const runReload = async () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      const snapshot = await opts.readSnapshot();
      if (!snapshot.valid) {
        const issues = snapshot.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join(", ");
        opts.log.warn(`config reload skipped (invalid config): ${issues}`);
        return;
      }
      const nextConfig = snapshot.config;
      const changedPaths = diffConfigPaths(currentConfig, nextConfig);
      currentConfig = nextConfig;
      settings = resolveGatewayReloadSettings(nextConfig);
      if (changedPaths.length === 0) return;

      const plan = buildGatewayReloadPlan(changedPaths);
      if (settings.mode === "off") {
        opts.log.info("config reload disabled (gateway.reload.mode=off)");
        return;
      }
      if (settings.mode === "restart") {
        if (!restartQueued) {
          restartQueued = true;
          opts.onRestart(plan, nextConfig);
        }
        return;
      }
      if (plan.restartGateway) {
        if (settings.mode === "hot") {
          opts.log.warn(
            `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
              ", ",
            )})`,
          );
          return;
        }
        if (!restartQueued) {
          restartQueued = true;
          opts.onRestart(plan, nextConfig);
        }
        return;
      }

      await opts.onHotReload(plan, nextConfig);
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const watcher = chokidar.watch(opts.watchPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  watcher.on("error", (err) => {
    opts.log.warn(`config watcher error: ${String(err)}`);
  });

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      await watcher.close().catch(() => {});
    },
  };
}
