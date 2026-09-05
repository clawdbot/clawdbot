/** Compiled manifest policy for one exact metadata snapshot and config object. */
export type ManifestModelSuppressionResolver = (input: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  unconditionalOnly?: boolean;
}) => { suppress: true; errorMessage: string } | undefined;
