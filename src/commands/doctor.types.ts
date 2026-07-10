/** CLI option shape shared by doctor command entrypoints and prompt helpers. */
export type DoctorOptions = {
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
  repair?: boolean;
  force?: boolean;
  generateGatewayToken?: boolean;
  allowExec?: boolean;
  postUpgrade?: boolean;
  json?: boolean;
  /** Internal capability granted only to direct operator-owned doctor invocations. */
  crossStateDirImports?: boolean;
};
