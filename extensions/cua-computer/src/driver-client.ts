import { randomUUID } from "node:crypto";

type DriverClickButton = import("@trycua/cua-driver").ClickButton;
type CuaDriverLike = import("@trycua/cua-driver").CuaDriverLike;
type CuaDriverSessionLike = import("@trycua/cua-driver").CuaDriverSessionLike;
type DriverScrollDirection = import("@trycua/cua-driver").ScrollDirection;
type CuaDriverSdk = Pick<
  typeof import("@trycua/cua-driver"),
  | "CaptureScope"
  | "CuaDriver"
  | "DesktopScope"
  | "ScrollBy"
  | "SessionPermissionMode"
  | "createTrustedSession"
>;

export type CuaToolResult = import("@trycua/cua-driver").ToolResult;

// These numeric values are part of the pinned 0.14.1 SDK contract. Keeping
// them local avoids loading the native library while OpenClaw is only
// registering the bundled plugin.
export const ClickButton = {
  Left: 0 as DriverClickButton,
  Right: 1 as DriverClickButton,
  Middle: 2 as DriverClickButton,
} as const;
export type ClickButton = (typeof ClickButton)[keyof typeof ClickButton];

export const ScrollDirection = {
  Up: 0 as DriverScrollDirection,
  Down: 1 as DriverScrollDirection,
  Left: 2 as DriverScrollDirection,
  Right: 3 as DriverScrollDirection,
} as const;
export type ScrollDirection = (typeof ScrollDirection)[keyof typeof ScrollDirection];

export interface CuaDriverSession {
  readonly generation: string;
  isAvailable(): boolean;
  resetAvailabilityCache(): void;
  getDesktopState(signal?: AbortSignal): Promise<CuaToolResult>;
  getScreenSize(signal?: AbortSignal): Promise<CuaToolResult>;
  click(
    input: { x: number; y: number; button: ClickButton; count: number },
    signal?: AbortSignal,
  ): Promise<CuaToolResult>;
  drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ): Promise<CuaToolResult>;
  moveCursor(input: { x: number; y: number }, signal?: AbortSignal): Promise<CuaToolResult>;
  scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ): Promise<CuaToolResult>;
  typeText(text: string, signal?: AbortSignal): Promise<CuaToolResult>;
  pressKey(
    input: { key: string; modifiers: string[] },
    signal?: AbortSignal,
  ): Promise<CuaToolResult>;
  dispose(): Promise<void>;
}

function asyncOptions(signal?: AbortSignal) {
  return signal ? { signal } : undefined;
}

class DirectCuaDriverSession implements CuaDriverSession {
  readonly generation = randomUUID();
  private readonly runtime: CuaDriverLike;
  private readonly session: CuaDriverSessionLike;
  private readonly publicSession = `openclaw-${randomUUID()}`;
  private startPromise: Promise<void> | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly sdk: CuaDriverSdk) {
    const unrestricted = sdk.SessionPermissionMode.Unrestricted;
    // This is an OpenClaw-owned ceiling, not plugin configuration or tool input.
    // The model cannot select a session or widen this authorization after start.
    const authorization = {
      allowedModes: [unrestricted],
      compatibilityMode: unrestricted,
      unrestrictedAcknowledged: true,
      maxSessionTtlSeconds: 3_600n,
      maxIdleTtlSeconds: 300n,
    };
    // Never use CuaDriver.create(): configured creation fixes the authorization
    // ceiling before a single trusted OpenClaw session is admitted.
    this.runtime = sdk.CuaDriver.createConfigured({
      claudeCodeCompatibility: false,
      authorization,
    });
    this.session = sdk.createTrustedSession(this.runtime, {
      publicSession: this.publicSession,
      mode: unrestricted,
      ttlSeconds: authorization.maxSessionTtlSeconds,
      idleTtlSeconds: authorization.maxIdleTtlSeconds,
    });
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer is stopping");
    }
    if (!this.startPromise) {
      const start = this.session
        .startSession(
          { session: this.publicSession, captureScope: this.sdk.CaptureScope.Desktop },
          asyncOptions(signal),
        )
        .then(() => {
          this.started = true;
        });
      this.startPromise = start;
      try {
        await start;
      } catch (error) {
        if (this.startPromise === start) {
          this.startPromise = undefined;
        }
        throw error;
      }
      return;
    }
    await this.startPromise;
  }

  private async invoke<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureStarted(signal);
    return await operation();
  }

  isAvailable(): boolean {
    return !this.disposed && this.runtime.isAvailable();
  }
  resetAvailabilityCache(): void {}
  async getDesktopState(signal?: AbortSignal) {
    return await this.invoke(signal, () => this.session.getDesktopState({}, asyncOptions(signal)));
  }
  async getScreenSize(signal?: AbortSignal) {
    return await this.invoke(signal, () => this.session.getScreenSize({}, asyncOptions(signal)));
  }
  async click(
    input: { x: number; y: number; button: ClickButton; count: number },
    signal?: AbortSignal,
  ) {
    return await this.invoke(signal, () =>
      this.session.click({ ...input, scope: this.sdk.DesktopScope.Desktop }, asyncOptions(signal)),
    );
  }
  async drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ) {
    return await this.invoke(signal, () =>
      this.session.drag({ ...input, scope: this.sdk.DesktopScope.Desktop }, asyncOptions(signal)),
    );
  }
  async moveCursor(input: { x: number; y: number }, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.moveCursor(
        { ...input, scope: this.sdk.DesktopScope.Desktop },
        asyncOptions(signal),
      ),
    );
  }
  async scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ) {
    return await this.invoke(signal, () =>
      this.session.scroll(
        {
          ...input,
          scope: this.sdk.DesktopScope.Desktop,
          by: this.sdk.ScrollBy.Line,
        },
        asyncOptions(signal),
      ),
    );
  }
  async typeText(text: string, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.typeText({ text, scope: this.sdk.DesktopScope.Desktop }, asyncOptions(signal)),
    );
  }
  async pressKey(input: { key: string; modifiers: string[] }, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.pressKey(
        { ...input, scope: this.sdk.DesktopScope.Desktop },
        asyncOptions(signal),
      ),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    let failure: unknown;
    try {
      await this.startPromise;
    } catch (error) {
      failure = error;
    }
    if (this.started) {
      try {
        // End the native desktop session before revoking its trusted handle.
        // Closing only the handle can leave the started session behind on stop.
        await this.session.endSession({ session: this.publicSession });
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      this.session.close();
    } catch (error) {
      failure = error;
    }
    try {
      await this.runtime.shutdown();
    } catch (error) {
      failure ??= error;
    }
    try {
      (this.runtime as CuaDriverLike & { uniffiDestroy?: () => void }).uniffiDestroy?.();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      throw failure instanceof Error
        ? failure
        : new Error("CUA Driver cleanup failed", { cause: failure });
    }
  }
}

async function loadCuaDriverSdk(): Promise<CuaDriverSdk> {
  return (await import("@trycua/cua-driver")) as CuaDriverSdk;
}

function unavailableError(failure: unknown): Error {
  const detail = failure instanceof Error ? failure.message : String(failure);
  return new Error(`COMPUTER_DRIVER_UNAVAILABLE: failed to load CUA Driver SDK: ${detail}`, {
    cause: failure,
  });
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

class LazyCuaDriverSession implements CuaDriverSession {
  private readonly unloadedGeneration = randomUUID();
  private runtime: DirectCuaDriverSession | undefined;
  private loadPromise: Promise<DirectCuaDriverSession> | undefined;
  private loadFailure: unknown;
  private hasLoadFailure = false;
  private disposed = false;

  constructor(private readonly loadSdk: () => CuaDriverSdk | Promise<CuaDriverSdk>) {}

  get generation(): string {
    return this.runtime?.generation ?? this.unloadedGeneration;
  }

  private resolveRuntime(): DirectCuaDriverSession | undefined {
    if (this.disposed || this.hasLoadFailure || this.loadPromise) {
      return undefined;
    }
    if (this.runtime) {
      return this.runtime;
    }
    try {
      const loadedSdk = this.loadSdk();
      if (!isPromise(loadedSdk)) {
        this.runtime = new DirectCuaDriverSession(loadedSdk);
        return this.runtime;
      }

      const loadPromise = loadedSdk
        .then((sdk) => new DirectCuaDriverSession(sdk))
        .then((runtime) => {
          this.runtime = runtime;
          return runtime;
        })
        .catch((error: unknown) => {
          this.loadFailure = error;
          this.hasLoadFailure = true;
          throw error;
        })
        .finally(() => {
          if (this.loadPromise === loadPromise) {
            this.loadPromise = undefined;
          }
        });
      this.loadPromise = loadPromise;
      // Availability is synchronous, so the first probe starts the ESM import
      // and reports unavailable until a later probe observes the loaded SDK.
      void loadPromise.catch(() => {});
      return this.runtime;
    } catch (error) {
      this.loadFailure = error;
      this.hasLoadFailure = true;
      return undefined;
    }
  }

  private async requireRuntime(): Promise<DirectCuaDriverSession> {
    const runtime = this.resolveRuntime();
    if (runtime) {
      return runtime;
    }
    if (this.loadPromise) {
      try {
        return await this.loadPromise;
      } catch (error) {
        throw unavailableError(this.loadFailure ?? error);
      }
    }
    throw unavailableError(
      this.disposed ? new Error("cua-computer is stopping") : this.loadFailure,
    );
  }

  isAvailable(): boolean {
    return this.resolveRuntime()?.isAvailable() ?? false;
  }

  resetAvailabilityCache(): void {
    if (this.runtime) {
      this.runtime.resetAvailabilityCache();
    } else if (!this.disposed && !this.loadPromise) {
      this.loadFailure = undefined;
      this.hasLoadFailure = false;
    }
  }

  async getDesktopState(signal?: AbortSignal) {
    return await (await this.requireRuntime()).getDesktopState(signal);
  }
  async getScreenSize(signal?: AbortSignal) {
    return await (await this.requireRuntime()).getScreenSize(signal);
  }
  async click(
    input: { x: number; y: number; button: ClickButton; count: number },
    signal?: AbortSignal,
  ) {
    return await (await this.requireRuntime()).click(input, signal);
  }
  async drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ) {
    return await (await this.requireRuntime()).drag(input, signal);
  }
  async moveCursor(input: { x: number; y: number }, signal?: AbortSignal) {
    return await (await this.requireRuntime()).moveCursor(input, signal);
  }
  async scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ) {
    return await (await this.requireRuntime()).scroll(input, signal);
  }
  async typeText(text: string, signal?: AbortSignal) {
    return await (await this.requireRuntime()).typeText(text, signal);
  }
  async pressKey(input: { key: string; modifiers: string[] }, signal?: AbortSignal) {
    return await (await this.requireRuntime()).pressKey(input, signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      await this.loadPromise;
    } catch {
      // A failed load has no native resources to release.
    }
    await this.runtime?.dispose();
  }
}

export function createCuaDriver(
  options: { loadSdk?: () => CuaDriverSdk | Promise<CuaDriverSdk> } = {},
): CuaDriverSession {
  return new LazyCuaDriverSession(options.loadSdk ?? loadCuaDriverSdk);
}
