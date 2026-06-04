// Shared mock reset contract for generated-media runtime tests.

type ClearableMock = {
  mockClear(): unknown;
};

type ResettableMock = {
  mockReset(): unknown;
};

type ResettableReturnMock = ResettableMock & {
  mockReturnValue(value: unknown): unknown;
};

/** Common mock shape shared by image, music, and video generation runtime tests. */
export type GenerationRuntimeMocks = {
  createSubsystemLogger: ClearableMock;
  describeFailoverError: ResettableMock;
  getProvider: ResettableReturnMock;
  getProviderEnvVars: ResettableReturnMock;
  resolveProviderAuthEnvVarCandidates: ResettableReturnMock;
  resolveProviderAuthLookupMaps: ResettableReturnMock;
  isFailoverError: ResettableReturnMock;
  listProviders: ResettableReturnMock;
  parseModelRef: ClearableMock;
  resolveAgentModelFallbackValues: ResettableReturnMock;
  resolveAgentModelPrimaryValue: ResettableReturnMock;
  debug: ResettableMock;
  warn: ResettableMock;
};

/** Reset generated-media runtime mocks to default no-provider behavior. */
export function resetGenerationRuntimeMocks(mocks: GenerationRuntimeMocks): void {
  mocks.createSubsystemLogger.mockClear();
  mocks.describeFailoverError.mockReset();
  mocks.getProvider.mockReset();
  mocks.getProviderEnvVars.mockReset();
  mocks.getProviderEnvVars.mockReturnValue([]);
  mocks.resolveProviderAuthEnvVarCandidates.mockReset();
  mocks.resolveProviderAuthEnvVarCandidates.mockReturnValue({});
  mocks.resolveProviderAuthLookupMaps.mockReset();
  mocks.resolveProviderAuthLookupMaps.mockReturnValue({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  });
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
