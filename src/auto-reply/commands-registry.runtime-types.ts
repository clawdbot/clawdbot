/** Runtime type contracts for command routing helpers loaded across lazy boundaries. */
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

/** Runtime-injected policy hook for whether text slash commands should be honored. */
export type ShouldHandleTextCommands = (params: ShouldHandleTextCommandsParams) => boolean;
