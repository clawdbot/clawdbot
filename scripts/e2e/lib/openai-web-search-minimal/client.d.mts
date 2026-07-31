export namespace testing {
  export { DEFAULT_GATEWAY_SCHEMA_ERROR };
  export { DEFAULT_RAW_SCHEMA_ERROR };
  export { SUCCESS_MARKER };
  export { extractSuccessReplyTexts };
  export { resolveGatewayPort };
  export { validateSuccessResult };
  export { validateRejectResult };
}
declare const DEFAULT_GATEWAY_SCHEMA_ERROR: "provider rejected the request schema or tool payload";
declare const DEFAULT_RAW_SCHEMA_ERROR: "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.";
declare const SUCCESS_MARKER: "OPENCLAW_SCHEMA_E2E_OK";
declare function extractSuccessReplyTexts(value: unknown): unknown[];
declare function resolveGatewayPort(env?: NodeJS.ProcessEnv): number;
declare function validateSuccessResult(result: unknown, marker?: string): void;
declare function validateRejectResult(result: unknown, expectedRawSchemaError?: string): string;
