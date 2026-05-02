/**
 * Group message gate — unified entry point for group inbound gating.
 *
 * Collapses three orthogonal rules that previously lived in ad-hoc spots
 * of the standalone gateway into a single pure function. Callers pass in
 * the message's mention state plus the resolved configuration, and get
 * back a structured action telling them how to handle the message.
 *
 * Evaluation order (short-circuit at the first match):
 *   1. `ignoreOtherMentions` — message @-s someone else but not the bot
 *                              → `drop_other_mention` (record to history,
 *                              then drop). Implicit mentions (e.g. quoting
 *                              a bot reply) still count as @bot.
 *   2. `block_unauthorized_command` — sender is not allowed to run control
 *                                     commands (text starts with `/xxx`)
 *                                     → silently drop.
 *   3. `mention gating` — when `requireMention` is on, non-@bot messages
 *                         are `skip_no_mention`'d (still buffered to
 *                         history). Authorized control commands can
 *                         **bypass** the gate as long as the message does
 *                         not @anyone else at the same time.
 *   4. Otherwise → `pass` (the message will reach the AI pipeline).
 *
 * All inputs are plain data; there is no I/O and no mutation, so the
 * function is safe to share between the built-in and standalone builds.
 */

// ────────────────────── Types ──────────────────────

/**
 * Structured action returned by {@link resolveGroupMessageGate}.
 *
 * - `drop_other_mention`        — message @-s another user but not the bot;
 *                                 record to the group history cache and
 *                                 drop without hitting the AI.
 * - `block_unauthorized_command` — silently refuse a control command from
 *                                  an unauthorized sender (no history
 *                                  write, no AI call).
 * - `skip_no_mention`           — `requireMention` is on and the message
 *                                 does not @bot; record to history but
 *                                 skip AI dispatch.
 * - `pass`                      — forward the message to the AI pipeline.
 */
type GroupMessageGateAction =
  | "drop_other_mention"
  | "block_unauthorized_command"
  | "skip_no_mention"
  | "pass";

/** Gate evaluation result. */
export interface GroupMessageGateResult {
  /** The action the caller should take. */
  action: GroupMessageGateAction;
  /**
   * Effective mention state after combining raw mention detection with
   * implicit / bypass signals. Only meaningful when `action === "pass"`.
   */
  effectiveWasMentioned: boolean;
  /**
   * Whether the control-command bypass was applied to flip a missing
   * mention into `pass`. Only meaningful when `action === "pass"`.
   */
  shouldBypassMention: boolean;
}

/** Input for {@link resolveGroupMessageGate}. */
export interface GroupMessageGateInput {
  // ---- ignoreOtherMentions layer ----
  /** Per-group config: drop messages that @someone other than the bot. */
  ignoreOtherMentions: boolean;
  /** Whether the message contains *any* @mention (including @other-user). */
  hasAnyMention: boolean;
  /**
   * Whether the QQ event explicitly @-s the bot (via `mentions[].is_you`
   * or `GROUP_AT_MESSAGE_CREATE`).
   */
  wasMentioned: boolean;
  /**
   * Implicit mention — e.g. the message quotes an earlier bot reply.
   * Treated as equivalent to an explicit @bot for gating purposes.
   */
  implicitMention: boolean;

  // ---- Control-command layer ----
  /** Whether text-based control commands are enabled globally. */
  allowTextCommands: boolean;
  /** Whether the current message is recognised as a control command. */
  isControlCommand: boolean;
  /** Whether the sender is authorised to run control commands. */
  commandAuthorized: boolean;

  // ---- Mention gating layer ----
  /** Per-group config: `requireMention` — bot only replies when @-ed. */
  requireMention: boolean;
  /**
   * Whether the channel can reliably detect @-mentions at all. In C2C chat
   * this should be `false` (DMs don't have mentions); in group chat it
   * should be `true`.
   */
  canDetectMention: boolean;
}

// ────────────────────── Core logic ──────────────────────

/**
 * Base mention-gate evaluation.
 *
 * `effectiveWasMentioned = wasMentioned || implicitMention || bypass`.
 * `shouldSkip = requireMention && canDetectMention && !effectiveWasMentioned`.
 */
function resolveMentionGating(input: {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention: boolean;
  shouldBypassMention: boolean;
}): { effectiveWasMentioned: boolean; shouldSkip: boolean } {
  const effectiveWasMentioned =
    input.wasMentioned || input.implicitMention || input.shouldBypassMention;
  const shouldSkip = input.requireMention && input.canDetectMention && !effectiveWasMentioned;
  return { effectiveWasMentioned, shouldSkip };
}

/**
 * Decide whether an authorized control command may bypass the mention gate.
 *
 * All of the following must hold:
 *   1. `requireMention` is on         (gate is active)
 *   2. The bot was NOT directly @-ed  (otherwise no bypass is needed)
 *   3. The message does NOT @anyone   (a `@other-user /stop` should NOT pass
 *                                      — the command wasn't aimed at us)
 *   4. Text commands are enabled
 *   5. Sender is authorised
 *   6. The content is a valid control command
 */
function resolveCommandBypass(input: {
  requireMention: boolean;
  wasMentioned: boolean;
  hasAnyMention: boolean;
  allowTextCommands: boolean;
  commandAuthorized: boolean;
  isControlCommand: boolean;
}): boolean {
  return (
    input.requireMention &&
    !input.wasMentioned &&
    !input.hasAnyMention &&
    input.allowTextCommands &&
    input.commandAuthorized &&
    input.isControlCommand
  );
}

// ────────────────────── Unified gate ──────────────────────

/**
 * Evaluate the group-message gate.
 *
 * See the module-level docs for the ordering and semantics.
 */
export function resolveGroupMessageGate(input: GroupMessageGateInput): GroupMessageGateResult {
  // ---- Layer 1: ignoreOtherMentions ----
  if (
    input.ignoreOtherMentions &&
    input.hasAnyMention &&
    !input.wasMentioned &&
    !input.implicitMention
  ) {
    return {
      action: "drop_other_mention",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  // ---- Layer 2: unauthorized control command ----
  if (input.allowTextCommands && input.isControlCommand && !input.commandAuthorized) {
    return {
      action: "block_unauthorized_command",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  // ---- Layer 3: mention gate + command bypass ----
  const shouldBypassMention = resolveCommandBypass({
    requireMention: input.requireMention,
    wasMentioned: input.wasMentioned,
    hasAnyMention: input.hasAnyMention,
    allowTextCommands: input.allowTextCommands,
    commandAuthorized: input.commandAuthorized,
    isControlCommand: input.isControlCommand,
  });

  const mentionGate = resolveMentionGating({
    requireMention: input.requireMention,
    canDetectMention: input.canDetectMention,
    wasMentioned: input.wasMentioned,
    implicitMention: input.implicitMention,
    shouldBypassMention,
  });

  if (mentionGate.shouldSkip) {
    return {
      action: "skip_no_mention",
      effectiveWasMentioned: mentionGate.effectiveWasMentioned,
      shouldBypassMention,
    };
  }

  return {
    action: "pass",
    effectiveWasMentioned: mentionGate.effectiveWasMentioned,
    shouldBypassMention,
  };
}
