import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  AgentSessionRuntimeDiagnostic,
  AgentSessionServices,
} from "./agent-session-services.js";
import type { AgentSession } from "./agent-session.js";
import type {
  ReplacedSessionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { CreateAgentSessionResult } from "./sdk.js";
import { assertSessionCwdExists } from "./session-cwd.js";
import { SessionManager } from "./session-manager.js";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
  services: AgentSessionServices;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = "SessionImportFileNotFoundError";
    this.filePath = filePath;
  }
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
  private rebindSession?: (session: AgentSession) => Promise<void>;
  private beforeSessionInvalidate?: () => void;
  private currentSession: AgentSession;
  private runtimeServices: AgentSessionServices;
  private readonly createRuntime: CreateAgentSessionRuntimeFactory;
  private runtimeDiagnostics: AgentSessionRuntimeDiagnostic[];
  private fallbackMessage?: string;

  constructor(
    session: AgentSession,
    services: AgentSessionServices,
    createRuntime: CreateAgentSessionRuntimeFactory,
    diagnostics: AgentSessionRuntimeDiagnostic[] = [],
    modelFallbackMessage?: string,
  ) {
    this.currentSession = session;
    this.runtimeServices = services;
    this.createRuntime = createRuntime;
    this.runtimeDiagnostics = diagnostics;
    this.fallbackMessage = modelFallbackMessage;
  }

  get services(): AgentSessionServices {
    return this.runtimeServices;
  }

  get session(): AgentSession {
    return this.currentSession;
  }

  get cwd(): string {
    return this.runtimeServices.cwd;
  }

  get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
    return this.runtimeDiagnostics;
  }

  get modelFallbackMessage(): string | undefined {
    return this.fallbackMessage;
  }

  setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
    this.rebindSession = rebindSession;
  }

  /**
   * Set a synchronous callback that runs after `session_shutdown` handlers finish
   * but before the current session is invalidated.
   *
   * This is for host-owned UI teardown that must not yield to the event loop,
   * such as detaching extension-provided TUI components before the old extension
   * context becomes stale.
   */
  setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
    this.beforeSessionInvalidate = beforeSessionInvalidate;
  }

  private async emitBeforeSwitch(
    reason: "new" | "resume",
    targetSessionFile?: string,
  ): Promise<{ cancelled: boolean }> {
    const runner = this.currentSession.extensionRunner;
    if (!runner.hasHandlers("session_before_switch")) {
      return { cancelled: false };
    }

    const result = await runner.emit({
      type: "session_before_switch",
      reason,
      targetSessionFile,
    });
    return { cancelled: result?.cancel === true };
  }

  private async emitBeforeFork(
    entryId: string,
    options: { position: "before" | "at" },
  ): Promise<{ cancelled: boolean }> {
    const runner = this.currentSession.extensionRunner;
    if (!runner.hasHandlers("session_before_fork")) {
      return { cancelled: false };
    }

    const result = await runner.emit({
      type: "session_before_fork",
      entryId,
      ...options,
    });
    return { cancelled: result?.cancel === true };
  }

  private async teardownCurrent(
    reason: SessionShutdownEvent["reason"],
    targetSessionFile?: string,
  ): Promise<void> {
    await emitSessionShutdownEvent(this.currentSession.extensionRunner, {
      type: "session_shutdown",
      reason,
      targetSessionFile,
    });
    this.beforeSessionInvalidate?.();
    this.currentSession.dispose();
  }

  private apply(result: CreateAgentSessionRuntimeResult): void {
    this.currentSession = result.session;
    this.runtimeServices = result.services;
    this.runtimeDiagnostics = result.diagnostics;
    this.fallbackMessage = result.modelFallbackMessage;
  }

  private async finishSessionReplacement(
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
  ): Promise<void> {
    if (this.rebindSession) {
      await this.rebindSession(this.currentSession);
    }
    if (withSession) {
      await withSession(this.currentSession.createReplacedSessionContext());
    }
  }

  async switchSession(
    sessionPath: string,
    options?: {
      cwdOverride?: string;
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean }> {
    const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
    if (beforeResult.cancelled) {
      return beforeResult;
    }

    const previousSessionFile = this.currentSession.sessionFile;
    const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
    assertSessionCwdExists(sessionManager, this.cwd);
    await this.teardownCurrent("resume", sessionManager.getSessionFile());
    this.apply(
      await this.createRuntime({
        cwd: sessionManager.getCwd(),
        agentDir: this.runtimeServices.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
      }),
    );
    await this.finishSessionReplacement(options?.withSession);
    return { cancelled: false };
  }

  async newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }> {
    const beforeResult = await this.emitBeforeSwitch("new");
    if (beforeResult.cancelled) {
      return beforeResult;
    }

    const previousSessionFile = this.currentSession.sessionFile;
    const sessionDir = this.currentSession.sessionManager.getSessionDir();
    const sessionManager = SessionManager.create(this.cwd, sessionDir);
    if (options?.parentSession) {
      sessionManager.newSession({ parentSession: options.parentSession });
    }

    await this.teardownCurrent("new", sessionManager.getSessionFile());
    this.apply(
      await this.createRuntime({
        cwd: this.cwd,
        agentDir: this.runtimeServices.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
      }),
    );
    if (options?.setup) {
      await options.setup(this.currentSession.sessionManager);
      this.currentSession.agent.state.messages =
        this.currentSession.sessionManager.buildSessionContext().messages;
    }
    await this.finishSessionReplacement(options?.withSession);
    return { cancelled: false };
  }

  async fork(
    entryId: string,
    options?: {
      position?: "before" | "at";
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean; selectedText?: string }> {
    const position = options?.position ?? "before";
    const beforeResult = await this.emitBeforeFork(entryId, { position });
    if (beforeResult.cancelled) {
      return { cancelled: true };
    }
    let targetLeafId: string | null;
    let selectedText: string | undefined;

    const selectedEntry = this.currentSession.sessionManager.getEntry(entryId);
    if (!selectedEntry) {
      throw new Error("Invalid entry ID for forking");
    }

    if (position === "at") {
      targetLeafId = selectedEntry.id;
    } else {
      if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
        throw new Error("Invalid entry ID for forking");
      }
      targetLeafId = selectedEntry.parentId;
      selectedText = extractUserMessageText(selectedEntry.message.content);
    }

    const previousSessionFile = this.currentSession.sessionFile;
    if (this.currentSession.sessionManager.isPersisted()) {
      const currentSessionFile = this.currentSession.sessionFile;
      if (!currentSessionFile) {
        throw new Error("Persisted session is missing a session file");
      }
      const sessionDir = this.currentSession.sessionManager.getSessionDir();
      if (!targetLeafId) {
        const sessionManager = SessionManager.create(this.cwd, sessionDir);
        sessionManager.newSession({ parentSession: currentSessionFile });
        await this.teardownCurrent("fork", sessionManager.getSessionFile());
        this.apply(
          await this.createRuntime({
            cwd: this.cwd,
            agentDir: this.runtimeServices.agentDir,
            sessionManager,
            sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
          }),
        );
        await this.finishSessionReplacement(options?.withSession);
        return { cancelled: false, selectedText };
      }

      const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
      const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
      if (!forkedSessionPath) {
        throw new Error("Failed to create forked session");
      }
      await this.teardownCurrent("fork", sessionManager.getSessionFile());
      this.apply(
        await this.createRuntime({
          cwd: sessionManager.getCwd(),
          agentDir: this.runtimeServices.agentDir,
          sessionManager,
          sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
        }),
      );
      await this.finishSessionReplacement(options?.withSession);
      return { cancelled: false, selectedText };
    }

    const sessionManager = this.currentSession.sessionManager;
    if (!targetLeafId) {
      sessionManager.newSession({ parentSession: this.currentSession.sessionFile });
    } else {
      sessionManager.createBranchedSession(targetLeafId);
    }
    await this.teardownCurrent("fork", sessionManager.getSessionFile());
    this.apply(
      await this.createRuntime({
        cwd: this.cwd,
        agentDir: this.runtimeServices.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
      }),
    );
    await this.finishSessionReplacement(options?.withSession);
    return { cancelled: false, selectedText };
  }

  /**
   * Import a session JSONL file and switch runtime state to the imported session.
   *
   * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
   * @throws {SessionImportFileNotFoundError} When the input path does not exist.
   * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
   */
  async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
    const resolvedPath = resolve(inputPath);
    if (!existsSync(resolvedPath)) {
      throw new SessionImportFileNotFoundError(resolvedPath);
    }

    const sessionDir = this.currentSession.sessionManager.getSessionDir();
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const destinationPath = join(sessionDir, basename(resolvedPath));
    const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
    if (beforeResult.cancelled) {
      return beforeResult;
    }

    const previousSessionFile = this.currentSession.sessionFile;
    if (resolve(destinationPath) !== resolvedPath) {
      copyFileSync(resolvedPath, destinationPath);
    }

    const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
    assertSessionCwdExists(sessionManager, this.cwd);
    await this.teardownCurrent("resume", sessionManager.getSessionFile());
    this.apply(
      await this.createRuntime({
        cwd: sessionManager.getCwd(),
        agentDir: this.runtimeServices.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
      }),
    );
    await this.finishSessionReplacement();
    return { cancelled: false };
  }

  async dispose(): Promise<void> {
    await emitSessionShutdownEvent(this.currentSession.extensionRunner, {
      type: "session_shutdown",
      reason: "quit",
    });
    this.beforeSessionInvalidate?.();
    this.currentSession.dispose();
  }
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
  createRuntime: CreateAgentSessionRuntimeFactory,
  options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
  },
): Promise<AgentSessionRuntime> {
  assertSessionCwdExists(options.sessionManager, options.cwd);
  const result = await createRuntime(options);
  return new AgentSessionRuntime(
    result.session,
    result.services,
    createRuntime,
    result.diagnostics,
    result.modelFallbackMessage,
  );
}

export {
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionServicesOptions,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "./agent-session-services.js";
