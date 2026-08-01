import { randomUUID } from "node:crypto";
import {
  ClickButton,
  CuaDriver,
  DesktopScope,
  ScrollBy,
  ScrollDirection,
  SessionPermissionMode,
  createTrustedSession,
  type CuaDriverLike,
  type CuaDriverSessionLike,
  type ToolResult,
} from "@trycua/cua-driver";

export type CuaToolResult = ToolResult;

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

// This is an OpenClaw-owned ceiling, not plugin configuration or tool input.
// The model can request only computer.act actions; it cannot select a session
// or widen this authorization after the node host starts.
const CUA_OPENCLAW_AUTHORIZATION = {
  allowedModes: [SessionPermissionMode.Unrestricted],
  compatibilityMode: SessionPermissionMode.Unrestricted,
  unrestrictedAcknowledged: true,
  maxSessionTtlSeconds: 3_600n,
  maxIdleTtlSeconds: 300n,
};

function asyncOptions(signal?: AbortSignal) {
  return signal ? { signal } : undefined;
}

class DirectCuaDriverSession implements CuaDriverSession {
  readonly generation = randomUUID();
  private readonly runtime: CuaDriverLike;
  private readonly session: CuaDriverSessionLike;
  private disposed = false;

  constructor() {
    // Never use CuaDriver.create(): configured creation fixes the authorization
    // ceiling before a single trusted OpenClaw session is admitted.
    this.runtime = CuaDriver.createConfigured({
      claudeCodeCompatibility: false,
      authorization: { ...CUA_OPENCLAW_AUTHORIZATION },
    });
    this.session = createTrustedSession(this.runtime, {
      publicSession: `openclaw-${randomUUID()}`,
      mode: SessionPermissionMode.Unrestricted,
      ttlSeconds: CUA_OPENCLAW_AUTHORIZATION.maxSessionTtlSeconds,
      idleTtlSeconds: CUA_OPENCLAW_AUTHORIZATION.maxIdleTtlSeconds,
    });
  }

  isAvailable(): boolean {
    return !this.disposed && this.runtime.isAvailable();
  }
  resetAvailabilityCache(): void {}
  getDesktopState(signal?: AbortSignal) {
    return this.session.getDesktopState({}, asyncOptions(signal));
  }
  getScreenSize(signal?: AbortSignal) {
    return this.session.getScreenSize({}, asyncOptions(signal));
  }
  click(input: { x: number; y: number; button: ClickButton; count: number }, signal?: AbortSignal) {
    return this.session.click({ ...input, scope: DesktopScope.Desktop }, asyncOptions(signal));
  }
  drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ) {
    return this.session.drag({ ...input, scope: DesktopScope.Desktop }, asyncOptions(signal));
  }
  moveCursor(input: { x: number; y: number }, signal?: AbortSignal) {
    return this.session.moveCursor({ ...input, scope: DesktopScope.Desktop }, asyncOptions(signal));
  }
  scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ) {
    return this.session.scroll(
      { ...input, scope: DesktopScope.Desktop, by: ScrollBy.Line },
      asyncOptions(signal),
    );
  }
  typeText(text: string, signal?: AbortSignal) {
    return this.session.typeText({ text, scope: DesktopScope.Desktop }, asyncOptions(signal));
  }
  pressKey(input: { key: string; modifiers: string[] }, signal?: AbortSignal) {
    return this.session.pressKey({ ...input, scope: DesktopScope.Desktop }, asyncOptions(signal));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    let failure: unknown;
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

export function createCuaDriver(): CuaDriverSession {
  return new DirectCuaDriverSession();
}

export { ClickButton, ScrollDirection };
