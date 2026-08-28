export type AuthProfileStoreAssertionOptions = {
  missingMessage?: string;
  envRefMessage?: string;
  rawKeyMessage?: string;
  rawKeyNeedle?: string;
};

export declare function readSharedAuthProfileStoreText(stateDir: string): string;

export declare function assertNoLegacyPrimaryAuthRows(stateDir: string): void;

export declare function assertOpenAiEnvAuthProfileStore(
  storeJson: string,
  options?: AuthProfileStoreAssertionOptions,
): void;
