import type { OpenClawConfig } from "../config/types.openclaw.js";

type LoggingConfig = OpenClawConfig["logging"];
type InternalLoggingConfig = NonNullable<LoggingConfig> & {
  [fullContextToolPayloadRedaction]: true;
};

const fullContextToolPayloadRedaction = Symbol("full-context-tool-payload-redaction");

export const fullContextToolPayloadRedactionState = {
  mark(loggingConfig: LoggingConfig): InternalLoggingConfig {
    return {
      ...loggingConfig,
      [fullContextToolPayloadRedaction]: true,
    };
  },
  isMarked(loggingConfig: LoggingConfig): boolean {
    return Boolean(
      (loggingConfig as InternalLoggingConfig | undefined)?.[fullContextToolPayloadRedaction],
    );
  },
};
