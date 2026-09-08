/**
 * TypeBox schemas for shell/process tools exposed to model providers.
 *
 * Keep these schemas provider-friendly: flat fields, string enums, and explicit
 * descriptions that match runtime validation.
 */
import { Type } from "typebox";
import { executionTitleSchema, optionalStringEnum } from "./schema/typebox.js";

const EXEC_TOOL_HOST_VALUES = ["auto", "sandbox", "gateway", "node"] as const;
const PROCESS_TOOL_ACTIONS = [
  "list",
  "poll",
  "log",
  "write",
  "send-keys",
  "submit",
  "paste",
  "kill",
  "clear",
  "remove",
] as const;

/** Parameters accepted by the exec tool. */
export const execSchema = Type.Object({
  title: executionTitleSchema(),
  command: Type.String({ description: "Shell command." }),
  workdir: Type.Optional(
    Type.String({
      description: "Omit/empty string: default; whitespace-only invalid.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Literal overrides; no expansion. Omit to inherit.",
    }),
  ),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds before backgrounding; default 10000.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Background now; timeoutSeconds applies.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Process lifetime in seconds; 0 disables.",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description: "PTY for TTY-required CLIs/coding agents.",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Host elevation if allowed.",
    }),
  ),
  host: optionalStringEnum(EXEC_TOOL_HOST_VALUES, {
    description: "Omit/auto: inherit configured host.",
  }),
  ask: Type.Optional(
    Type.String({
      description:
        "Requests stricter approvals under tools.exec.mode and host policy; channel-origin calls cannot override host ask=off.",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

/** Exec parameters when no process-control continuation is authorized. */
export const execCompletionSchema = Type.Omit(execSchema, ["yieldMs", "background"]);

/** Parameters exposed by node-only exec surfaces. */
export const nodeExecSchema = Type.Object({
  title: execSchema.properties.title,
  command: execSchema.properties.command,
  workdir: execSchema.properties.workdir,
  env: execSchema.properties.env,
  timeoutSeconds: execSchema.properties.timeoutSeconds,
  host: optionalStringEnum(["node"] as const, {
    description: "Exec target. Only node is available on this tool surface.",
  }),
  node: execSchema.properties.node,
});

/** Parameters accepted by the process-control tool. */
export const processSchema = Type.Object({
  action: Type.String({
    enum: [...PROCESS_TOOL_ACTIONS],
    description: "Process action (list|poll|log|write|send-keys|submit|paste|kill|clear|remove)",
  }),
  sessionId: Type.Optional(Type.String({ description: "Required for every action except list." })),
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
