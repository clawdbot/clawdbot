/**
 * Agent harness error helpers.
 *
 * Registry and runtime callers use this stable error type to distinguish missing
 * harness selection from ordinary harness execution failures.
 */
/** Error thrown when a requested harness id is not registered. */
export class MissingAgentHarnessError extends Error {
  readonly harnessId: string;

  constructor(harnessId: string) {
    super(`Requested agent harness "${harnessId}" is not registered.`);
    this.name = "MissingAgentHarnessError";
    this.harnessId = harnessId;
  }
}

/** Returns whether an error is a missing harness error. */
export function isMissingAgentHarnessError(err: unknown): err is MissingAgentHarnessError {
  return err instanceof MissingAgentHarnessError;
}

/** A harness lost ownership of the session generation before the attempt could start. */
export class AgentHarnessSessionSupersededError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHarnessSessionSupersededError";
  }
}

/** A model-independent harness preflight failed before an attempt could start. */
export class AgentHarnessPreflightError extends Error {
  /** Opts fallback into skipping only candidates owned by the selected harness. */
  readonly scope?: "harness";

  constructor(message: string, options?: ErrorOptions & { scope?: "harness" }) {
    super(message, options);
    this.name = "AgentHarnessPreflightError";
    this.scope = options?.scope;
  }
}

/** A requested Matrix freshness gate cannot run on the selected plugin harness. */
export class PluginHarnessSourceFinalizationUnsupportedError extends AgentHarnessPreflightError {
  readonly harnessId: string;

  constructor(harnessId: string) {
    super(
      "The selected plugin agent runtime does not support Matrix fresh-message redraft and discard, so it was not started. " +
        "Use OpenClaw's registry-attested bundled Codex harness for plugin-harness freshness, select a supported embedded or CLI runtime, or set " +
        "channels.matrix.turnTaking.redraftDepth to 0 for participation-only mode.",
      { scope: "harness" },
    );
    this.name = "PluginHarnessSourceFinalizationUnsupportedError";
    this.harnessId = harnessId;
  }
}

export function isPluginHarnessSourceFinalizationUnsupportedError(
  err: unknown,
): err is PluginHarnessSourceFinalizationUnsupportedError {
  return err instanceof PluginHarnessSourceFinalizationUnsupportedError;
}

// The host records the selected harness where the attempt runs. Plugins can opt
// into harness-local fallback, but cannot suppress candidates by naming an owner.
const agentHarnessPreflightOwners = new WeakMap<AgentHarnessPreflightError, string>();

export function recordAgentHarnessPreflightOwner(error: unknown, harnessId: string): void {
  if (isAgentHarnessPreflightError(error) && error.scope === "harness") {
    agentHarnessPreflightOwners.set(error, harnessId);
  }
}

export function resolveAgentHarnessPreflightOwner(error: unknown): string | undefined {
  return isAgentHarnessPreflightError(error) ? agentHarnessPreflightOwners.get(error) : undefined;
}

/** Returns whether fallback would only repeat the same harness preflight failure. */
export function isAgentHarnessPreflightError(err: unknown): err is AgentHarnessPreflightError {
  return err instanceof AgentHarnessPreflightError;
}
