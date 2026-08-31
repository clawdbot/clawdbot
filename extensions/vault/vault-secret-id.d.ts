export type ParsedVaultSecretId = {
  secretPath: string;
  field: string;
};

export function parseVaultSecretId(id: string): ParsedVaultSecretId;
