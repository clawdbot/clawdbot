import { lazyCompile } from "./protocol-validator.js";
import {
  TerminalAttachParamsSchema,
  TerminalCloseParamsSchema,
  TerminalEventSchema,
  TerminalInputParamsSchema,
  TerminalOpenParamsSchema,
  TerminalResizeParamsSchema,
  TerminalTextParamsSchema,
  TerminalUploadParamsSchema,
  TerminalUploadResultSchema,
} from "./schema/terminal.js";

export const validateTerminalOpenParams = lazyCompile(TerminalOpenParamsSchema);
export const validateTerminalInputParams = lazyCompile(TerminalInputParamsSchema);
export const validateTerminalResizeParams = lazyCompile(TerminalResizeParamsSchema);
export const validateTerminalCloseParams = lazyCompile(TerminalCloseParamsSchema);
export const validateTerminalAttachParams = lazyCompile(TerminalAttachParamsSchema);
export const validateTerminalTextParams = lazyCompile(TerminalTextParamsSchema);
export const validateTerminalUploadParams = lazyCompile(TerminalUploadParamsSchema);
export const validateTerminalUploadResult = lazyCompile(TerminalUploadResultSchema);
export const validateTerminalEvent = lazyCompile(TerminalEventSchema);
