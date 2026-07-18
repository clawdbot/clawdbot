// Gateway Protocol schema module for the operator terminal surface.
// Terminal methods open a PTY-backed shell session bound to one authenticated
// operator connection and stream its bytes back over the existing WebSocket.
import type { Static } from "typebox";
import { Type } from "typebox";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
  MAX_TERMINAL_UPLOAD_NAME_LENGTH,
} from "../terminal-upload-constants.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

// PTY grids are bounded so a hostile client cannot request an allocation that
// overflows the terminal backend's row/column math.
const TerminalDimension = Type.Integer({ minimum: 1, maximum: 2000 });

/** Opens a shell session; the server picks the shell, cwd, and confinement. */
export const TerminalOpenParamsSchema = closedObject({
  // Optional agent selector; defaults to the gateway's default agent. The
  // session starts in that agent's workspace and inherits its isolation.
  agentId: Type.Optional(NonEmptyString),
  catalog: Type.Optional(
    closedObject({
      catalogId: NonEmptyString,
      hostId: NonEmptyString,
      threadId: NonEmptyString,
    }),
  ),
  cols: TerminalDimension,
  rows: TerminalDimension,
});
export type TerminalOpenParams = Static<typeof TerminalOpenParamsSchema>;

/** Result of a successful open; carries the facts the UI header renders. */
export const TerminalOpenResultSchema = closedObject({
  sessionId: NonEmptyString,
  agentId: NonEmptyString,
  shell: NonEmptyString,
  cwd: NonEmptyString,
  // True when the shell runs inside the agent's sandbox and cannot escape the
  // workspace; false for a host shell that can navigate the whole filesystem.
  confined: Type.Boolean(),
  title: Type.Optional(NonEmptyString),
});
export type TerminalOpenResult = Static<typeof TerminalOpenResultSchema>;

/** Writes client keystrokes to the session stdin. */
export const TerminalInputParamsSchema = closedObject({
  sessionId: NonEmptyString,
  // Raw terminal input (already-encoded escape sequences from the emulator).
  data: Type.String(),
});
export type TerminalInputParams = Static<typeof TerminalInputParamsSchema>;

/** Stages one file on the host bound to an existing terminal session. */
export const TerminalUploadParamsSchema = closedObject({
  sessionId: NonEmptyString,
  name: Type.String({ minLength: 1, maxLength: MAX_TERMINAL_UPLOAD_NAME_LENGTH }),
  contentBase64: Type.String({ maxLength: MAX_TERMINAL_UPLOAD_BASE64_LENGTH }),
});
export type TerminalUploadParams = Static<typeof TerminalUploadParamsSchema>;

/** Absolute temporary path pasted into the active terminal after upload. */
export const TerminalUploadResultSchema = closedObject({
  path: NonEmptyString,
  size: Type.Integer({ minimum: 0, maximum: MAX_TERMINAL_UPLOAD_BYTES }),
});
export type TerminalUploadResult = Static<typeof TerminalUploadResultSchema>;

/** Resizes the PTY grid after the client viewport changes. */
export const TerminalResizeParamsSchema = closedObject({
  sessionId: NonEmptyString,
  cols: TerminalDimension,
  rows: TerminalDimension,
});
export type TerminalResizeParams = Static<typeof TerminalResizeParamsSchema>;

/** Closes a session and kills its process tree. */
export const TerminalCloseParamsSchema = closedObject({ sessionId: NonEmptyString });
export type TerminalCloseParams = Static<typeof TerminalCloseParamsSchema>;

/**
 * Attaches the calling admin connection. Connection-owned sessions use
 * take-over; agent-owned sessions retain ownership and add a shared viewer.
 */
export const TerminalAttachParamsSchema = closedObject({ sessionId: NonEmptyString });
export type TerminalAttachParams = Static<typeof TerminalAttachParamsSchema>;

/** Result of a successful attach; mirrors open plus the replay buffer. */
export const TerminalAttachResultSchema = closedObject({
  sessionId: NonEmptyString,
  agentId: NonEmptyString,
  shell: NonEmptyString,
  cwd: NonEmptyString,
  confined: Type.Boolean(),
  // Recent raw output from the server's bounded ring buffer, replayed into
  // the client emulator before live terminal.data resumes. Not a true screen
  // snapshot: after truncation it can start mid-escape-sequence; emulators
  // recover on the next full repaint (prompt, clear, resize redraw).
  buffer: Type.String(),
  // Gateways include this cumulative UTF-16 snapshot offset when the client
  // advertises terminal-offset-seq. Optional across protocol-4 version skew.
  seq: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type TerminalAttachResult = Static<typeof TerminalAttachResultSchema>;

/** One attachable session, as reported by terminal.list. */
export const TerminalSessionInfoSchema = closedObject({
  sessionId: NonEmptyString,
  agentId: NonEmptyString,
  shell: NonEmptyString,
  cwd: NonEmptyString,
  confined: Type.Boolean(),
  /** False while the session is detached (no connection owns its stream). */
  attached: Type.Boolean(),
  /** Connection-owned session, or the trusted agent session key that owns it. */
  owner: Type.Optional(Type.Union([Type.Literal("conn"), Type.String({ pattern: "^agent:.+" })])),
  createdAtMs: Type.Integer({ minimum: 0 }),
});
export type TerminalSessionInfo = Static<typeof TerminalSessionInfoSchema>;

/**
 * Sessions a reconnecting admin client can attach. All admin connections see
 * the same list: the terminal surface is already operator.admin (full host
 * access), so cross-connection visibility adds no privilege.
 */
export const TerminalListResultSchema = closedObject({
  sessions: Type.Array(TerminalSessionInfoSchema),
});
export type TerminalListResult = Static<typeof TerminalListResultSchema>;

/** Reads the current output buffer as plain text without attaching. */
export const TerminalTextParamsSchema = closedObject({ sessionId: NonEmptyString });
export type TerminalTextParams = Static<typeof TerminalTextParamsSchema>;

/** Plain-text buffer contents (ANSI stripped); an agent/LLM affordance. */
export const TerminalTextResultSchema = closedObject({ text: Type.String() });
export type TerminalTextResult = Static<typeof TerminalTextResultSchema>;

/** Shared ok/void result for input, resize, and close. */
export const TerminalAckResultSchema = closedObject({ ok: Type.Boolean() });
export type TerminalAckResult = Static<typeof TerminalAckResultSchema>;

/** Streamed output chunk; seq is its cumulative UTF-16 end offset within the session. */
export const TerminalDataEventSchema = closedObject({
  sessionId: NonEmptyString,
  seq: Type.Integer({ minimum: 0 }),
  data: Type.String(),
});
export type TerminalDataEvent = Static<typeof TerminalDataEventSchema>;

/** Terminal end-of-life notice; the session id is invalid after this event. */
export const TerminalExitEventSchema = closedObject({
  sessionId: NonEmptyString,
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  signal: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  // Stable reason code so clients can distinguish process exit from a
  // server-side teardown (disconnect, idle sweep, config disable).
  reason: Type.Optional(
    Type.Union([
      Type.Literal("process_exit"),
      Type.Literal("closed"),
      Type.Literal("disconnected"),
      // Another admin connection attached the session away; the session is
      // still alive server-side, but no longer streams to this connection.
      Type.Literal("detached"),
      Type.Literal("error"),
    ]),
  ),
  error: Type.Optional(Type.String()),
});
export type TerminalExitEvent = Static<typeof TerminalExitEventSchema>;

/** Union of every event a terminal session can emit. */
export const TerminalEventSchema = Type.Union([TerminalDataEventSchema, TerminalExitEventSchema]);
export type TerminalEvent = Static<typeof TerminalEventSchema>;
