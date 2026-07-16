declare module "@aws/bedrock-token-generator" {
  export function getTokenProvider(opts?: {
    region?: string;
    expiresInSeconds?: number;
  }): () => Promise<string>;
}
