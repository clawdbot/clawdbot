import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

type FaceTimeHelperTarget = "FaceTime" | "Phone";

type HelperSupervisorTargetState = {
  target: FaceTimeHelperTarget;
  connected: boolean;
  attempts: number;
  injecting: boolean;
  queued: boolean;
  retryScheduled: boolean;
  stale: boolean;
  staleProcessId?: number;
  lastError?: string;
};

export type FaceTimeHelperSupervisorStatus = HelperSupervisorTargetState[];

type HelperSupervisorParams = {
  pluginRoot: string;
  logger: RuntimeLogger;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  connectedBundles: () => string[];
  initialGraceMs?: number;
  retryDelaysMs?: readonly number[];
  targetAvailable?: (target: FaceTimeHelperTarget) => boolean;
  processAlive?: (processId: number) => boolean;
  connectionGraceMs?: number;
};

const TARGET_BUNDLES: Record<FaceTimeHelperTarget, ReadonlySet<string>> = {
  FaceTime: new Set(["com.apple.FaceTime", "com.apple.FaceTime.FTConversationService"]),
  Phone: new Set(["com.apple.mobilephone", "com.apple.TelephonyUtilities"]),
};
const TARGET_APP_PATHS: Record<FaceTimeHelperTarget, string> = {
  FaceTime: "/System/Applications/FaceTime.app",
  Phone: "/System/Applications/Phone.app",
};
const TARGET_EXECUTABLES: Record<FaceTimeHelperTarget, string> = {
  FaceTime: "/System/Applications/FaceTime.app/Contents/MacOS/FaceTime",
  Phone: "/System/Applications/Phone.app/Contents/MacOS/Phone",
};
const FACETIME_HELPER_TARGETS = ["FaceTime", "Phone"] as const;

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

function targetForBundle(bundleIdentifier: string): FaceTimeHelperTarget | undefined {
  return FACETIME_HELPER_TARGETS.find((target) => TARGET_BUNDLES[target].has(bundleIdentifier));
}

export class FaceTimeHelperSupervisor {
  readonly #states: Map<FaceTimeHelperTarget, HelperSupervisorTargetState>;
  readonly #timers = new Map<FaceTimeHelperTarget, ReturnType<typeof setTimeout>>();
  readonly #retryDelaysMs: readonly number[];
  #injectionChain: Promise<void> = Promise.resolve();
  #started = false;
  #generation = 0;
  #abortController = new AbortController();

  constructor(private readonly params: HelperSupervisorParams) {
    this.#retryDelaysMs =
      params.retryDelaysMs && params.retryDelaysMs.length > 0
        ? params.retryDelaysMs
        : DEFAULT_RETRY_DELAYS_MS;
    const targetAvailable =
      params.targetAvailable ?? ((target) => existsSync(TARGET_APP_PATHS[target]));
    this.#states = new Map(
      FACETIME_HELPER_TARGETS.filter((target) => targetAvailable(target)).map((target) => [
        target,
        {
          target,
          connected: false,
          attempts: 0,
          injecting: false,
          queued: false,
          retryScheduled: false,
          stale: false,
        },
      ]),
    );
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#generation += 1;
    this.#abortController = new AbortController();
    this.#refreshConnections();
    for (const target of this.#states.keys()) {
      if (!this.#states.get(target)?.connected) {
        this.#schedule(target, this.params.initialGraceMs ?? 6_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#generation += 1;
    this.#abortController.abort(new Error("FaceTime helper supervisor stopped"));
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    await this.#injectionChain;
  }

  connected(bundleIdentifier: string): void {
    const target = targetForBundle(bundleIdentifier);
    if (!target) {
      return;
    }
    this.#refreshConnections();
    const state = this.#states.get(target);
    if (state) {
      state.connected = true;
      state.attempts = 0;
      state.stale = false;
      state.staleProcessId = undefined;
      state.lastError = undefined;
    }
    this.#cancelTimer(target);
  }

  disconnected(bundleIdentifier: string): void {
    const target = targetForBundle(bundleIdentifier);
    if (!target) {
      return;
    }
    this.#refreshConnections();
    if (this.#started && !this.#states.get(target)?.connected) {
      this.#schedule(target, this.#retryDelaysMs[0] ?? 1_000);
    }
  }

  stale(bundleIdentifier: string, processId: number): void {
    const target = targetForBundle(bundleIdentifier);
    const state = target ? this.#states.get(target) : undefined;
    if (!target || !state) {
      return;
    }
    const staleProcessId = processId > 0 ? processId : undefined;
    const wasStale = state.stale;
    // A stale helper reconnects every five seconds until its host app exits.
    // Treat the whole stale episode as one operator action so reconnects from
    // the app or its services cannot flood logs. An identical callback also
    // keeps the existing process-exit monitor's original deadline.
    if (state.stale && state.staleProcessId === staleProcessId) {
      return;
    }
    state.connected = false;
    state.stale = true;
    state.staleProcessId = staleProcessId;
    state.lastError = `Restart ${target} to load the updated OpenClaw helper`;
    if (!wasStale) {
      this.params.logger.warn(`[facetime] ${state.lastError}`);
    }
    if (processId > 0) {
      this.#scheduleStaleProcessCheck(target, processId);
    } else {
      this.#cancelTimer(target);
      void this.#resolveLegacyStaleProcess(target);
    }
  }

  status(): FaceTimeHelperSupervisorStatus {
    this.#refreshConnections();
    return [...this.#states.values()].map((state) =>
      Object.assign({}, state, { retryScheduled: this.#timers.has(state.target) }),
    );
  }

  #refreshConnections(): void {
    const bundles = new Set(this.params.connectedBundles());
    for (const target of FACETIME_HELPER_TARGETS) {
      const acceptedBundles = TARGET_BUNDLES[target];
      const state = this.#states.get(target);
      if (state) {
        state.connected = [...acceptedBundles].some((bundle) => bundles.has(bundle));
      }
    }
  }

  #cancelTimer(target: FaceTimeHelperTarget): void {
    const timer = this.#timers.get(target);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(target);
    }
  }

  #schedule(target: FaceTimeHelperTarget, delayMs: number): void {
    this.#cancelTimer(target);
    const timer = setTimeout(() => {
      this.#timers.delete(target);
      this.#enqueueInjection(target);
    }, delayMs);
    timer.unref?.();
    this.#timers.set(target, timer);
  }

  #scheduleStaleProcessCheck(target: FaceTimeHelperTarget, processId: number): void {
    this.#cancelTimer(target);
    const timer = setTimeout(() => {
      this.#timers.delete(target);
      if (!this.#started) {
        return;
      }
      const processAlive =
        this.params.processAlive ??
        ((candidate: number) => {
          try {
            process.kill(candidate, 0);
            return true;
          } catch (error) {
            if (error && typeof error === "object" && "code" in error) {
              return error.code !== "ESRCH";
            }
            return true;
          }
        });
      const state = this.#states.get(target);
      if (!state?.stale || state.staleProcessId !== processId) {
        return;
      }
      if (processAlive(processId)) {
        this.#scheduleStaleProcessCheck(target, processId);
        return;
      }
      state.stale = false;
      state.staleProcessId = undefined;
      state.attempts = 0;
      state.lastError = undefined;
      this.#schedule(target, 0);
    }, 2_000);
    timer.unref?.();
    this.#timers.set(target, timer);
  }

  async #resolveLegacyStaleProcess(target: FaceTimeHelperTarget): Promise<void> {
    const state = this.#states.get(target);
    if (!this.#started || !state?.stale || state.staleProcessId !== undefined) {
      return;
    }
    try {
      const result = await this.params.runCommandWithTimeout(
        ["/usr/bin/pgrep", "-f", TARGET_EXECUTABLES[target]],
        { timeoutMs: 5_000 },
      );
      const processId = Number.parseInt(result.stdout.trim().split(/\s+/u)[0] ?? "", 10);
      if (result.code === 0 && Number.isSafeInteger(processId) && processId > 0) {
        state.staleProcessId = processId;
        this.#scheduleStaleProcessCheck(target, processId);
        return;
      }
    } catch (error) {
      this.params.logger.debug?.(
        `[facetime] failed to resolve stale ${target} helper process: ${formatErrorMessage(error)}`,
      );
    }
    if (this.#started && state.stale && state.staleProcessId === undefined) {
      state.stale = false;
      state.lastError = undefined;
      this.#schedule(target, 0);
    }
  }

  #enqueueInjection(target: FaceTimeHelperTarget): void {
    const state = this.#states.get(target);
    if (!state || state.queued || state.injecting) {
      return;
    }
    state.queued = true;
    const generation = this.#generation;
    const pending = this.#injectionChain.then(async () => {
      state.queued = false;
      if (this.#started && generation === this.#generation) {
        await this.#inject(target, generation);
      }
    });
    this.#injectionChain = pending.catch(() => undefined);
  }

  async #waitForAuthenticatedConnection(
    target: FaceTimeHelperTarget,
    generation: number,
  ): Promise<void> {
    const deadline = Date.now() + (this.params.connectionGraceMs ?? 10_000);
    while (this.#started && generation === this.#generation && Date.now() < deadline) {
      this.#refreshConnections();
      const state = this.#states.get(target);
      if (!state || state.connected || state.stale) {
        return;
      }
      await sleepWithAbort(250, this.#abortController.signal).catch(() => undefined);
    }
    this.#refreshConnections();
  }

  async #inject(target: FaceTimeHelperTarget, generation: number): Promise<void> {
    if (!this.#started || generation !== this.#generation) {
      return;
    }
    this.#refreshConnections();
    const state = this.#states.get(target);
    if (!state || state.connected || state.injecting || state.stale) {
      return;
    }
    state.injecting = true;
    state.attempts += 1;
    const script = resolve(this.params.pluginRoot, "scripts", "inject-helper.sh");
    try {
      const result = await this.params.runCommandWithTimeout(
        ["/bin/bash", script, "--app", target],
        {
          timeoutMs: 120_000,
          signal: this.#abortController.signal,
          killProcessTree: true,
        },
      );
      if (!this.#started || generation !== this.#generation) {
        return;
      }
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || `exit ${result.code}`);
      }
      state.lastError = undefined;
      this.params.logger.info(`[facetime] injected helper into ${target}`);
      if (!state.connected && !state.stale) {
        await this.#waitForAuthenticatedConnection(target, generation);
        if (!state.connected && !state.stale) {
          throw new Error(
            `${target} helper injection completed but no authenticated connection arrived`,
          );
        }
      }
    } catch (error) {
      if (this.#started && generation === this.#generation) {
        state.lastError = formatErrorMessage(error);
        this.params.logger.warn(`[facetime] ${target} helper injection failed: ${state.lastError}`);
      }
    } finally {
      state.injecting = false;
    }
    if (!this.#started || generation !== this.#generation) {
      return;
    }
    this.#refreshConnections();
    if (!state.connected && !state.stale) {
      const retryIndex = Math.min(state.attempts - 1, this.#retryDelaysMs.length - 1);
      this.#schedule(target, this.#retryDelaysMs[retryIndex] ?? 60_000);
    }
  }
}
