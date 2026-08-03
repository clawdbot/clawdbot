/**
 * Lazy runtime SDK subpath for command status reply generation.
 */
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type CommandStatusRuntime = typeof import("./command-status.runtime.js");

const loadCommandStatusRuntime = createLazyRuntimeModule(
  () => import("./command-status.runtime.js"),
);
const bindCommandStatusRuntime = createLazyRuntimeMethodBinder(loadCommandStatusRuntime);

export type { ResolveDirectStatusReplyForSessionParams } from "./command-status.runtime.js";

/** Resolves the direct status reply text for a session without eagerly loading runtime code. */
export const resolveDirectStatusReplyForSession: CommandStatusRuntime["resolveDirectStatusReplyForSession"] =
  bindCommandStatusRuntime((runtime) => runtime.resolveDirectStatusReplyForSession);
