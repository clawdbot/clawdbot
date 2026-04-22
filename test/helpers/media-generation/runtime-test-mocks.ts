type ClearableMock = {
  mockClear(): unknown;
};

type ResettableMock = {
  mockReset(): unknown;
};

type ResettableReturnMock = ResettableMock & {
  mockReturnValue(value: unknown): unknown;
};

export type GenerationRuntimeMocks = {
  createSubsystemLogger: ClearableMock;
  describeFailoverError: ResettableMock;
  getProvider: ResettableReturnMock;
  getProviderEnvVars: ResettableReturnMock;
  resolveProviderAuthEnvVarCandidates: ResettableReturnMock;
  isFailoverError: ResettableReturnMock;
  listProviders: ResettableReturnMock;
  parseModelRef: ClearableMock;
  resolveAgentModelFallbackValues: ResettableReturnMock;
  resolveAgentModelPrimaryValue: ResettableReturnMock;
  debug: ResettableMock;
  warn: ResettableMock;
};

export function resetGenerationRuntimeMocks(mocks: GenerationRuntimeMocks): void {
  mocks.createSubsystemLogger.mockClear();
  mocks.describeFailoverError.mockReset();
  mocks.getProvider.mockReset();
  mocks.getProviderEnvVars.mockReset();
  mocks.getProviderEnvVars.mockReturnValue([]);
  mocks.resolveProviderAuthEnvVarCandidates.mockReset();
  mocks.resolveProviderAuthEnvVarCandidates.mockReturnValue({});
  mocks.isFailoverError.mockReset();
  mocks.isFailoverError.mockReturnValue(false);
  mocks.listProviders.mockReset();
  mocks.listProviders.mockReturnValue([]);
  mocks.parseModelRef.mockClear();
  mocks.resolveAgentModelFallbackValues.mockReset();
  mocks.resolveAgentModelFallbackValues.mockReturnValue([]);
  mocks.resolveAgentModelPrimaryValue.mockReset();
  mocks.resolveAgentModelPrimaryValue.mockReturnValue(undefined);
  mocks.debug.mockReset();
  mocks.warn.mockReset();
}
