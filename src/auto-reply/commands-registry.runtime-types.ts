import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

export type ShouldHandleTextCommands = (params: ShouldHandleTextCommandsParams) => boolean;
