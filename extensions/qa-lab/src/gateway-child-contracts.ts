// Qa Lab leaf contracts shared by the Gateway child and suite runtime.
export type QaGatewayChildStateMutationContext = {
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  stateDir: string;
  tempRoot: string;
};

export type QaGatewayChildRestartOptions = {
  shutdownMode?: "graceful" | "hard";
};
