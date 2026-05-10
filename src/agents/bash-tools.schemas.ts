import { Type } from "typebox";
import { optionalStringEnum } from "./schema/typebox.js";

const EXEC_TOOL_HOST_VALUES = ["auto", "sandbox", "gateway", "node"] as const;

export const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: optionalStringEnum(EXEC_TOOL_HOST_VALUES, {
    description: "Exec host/target (auto|sandbox|gateway|node).",
  }),
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

export const processSchema = Type.Object({
  action: Type.String({
    description: "Process action (list|poll|log|write|send-keys|submit|paste|kill|clear|remove)",
  }),
  sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list" })),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  hex: Type.Optional(Type.Array(Type.String(), { description: "Hex bytes to send for send-keys" })),
  literal: Type.Optional(Type.String({ description: "Literal string for send-keys" })),
  text: Type.Optional(Type.String({ description: "Text to paste for paste" })),
  bracketed: Type.Optional(Type.Boolean({ description: "Wrap paste in bracketed mode" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
  timeout: Type.Optional(
    Type.Number({
      description:
        "For poll: wait up to this many milliseconds before returning; max 30000 ms, higher values are clamped to 30000",
      minimum: 0,
    }),
  ),
});
