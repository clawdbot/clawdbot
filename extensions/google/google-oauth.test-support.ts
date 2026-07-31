type OAuthSettingsFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  homedir: () => string;
};

type CredentialFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  realpathSync: (path: string) => string;
  readdirSync: (path: string, options: { withFileTypes: true }) => import("node:fs").Dirent[];
};

type OAuthCredentialsTestApi = {
  clearCredentialsCache: () => void;
  setFs: (overrides?: Partial<CredentialFs>) => void;
};

type OAuthSettingsTestApi = {
  setFs: (overrides?: Partial<OAuthSettingsFs>) => void;
};

type VertexAdcTestApi = {
  reset: () => void;
};

function requireTestApi(key: string): unknown {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(key)];
  if (!api) {
    throw new Error(`Google test API is unavailable: ${key}`);
  }
  return api;
}

export function clearGoogleOAuthCredentialsCache(): void {
  (
    requireTestApi("openclaw.google.oauthCredentialsTestApi") as OAuthCredentialsTestApi
  ).clearCredentialsCache();
}

export function setGoogleOAuthCredentialsFs(overrides?: Partial<CredentialFs>): void {
  (requireTestApi("openclaw.google.oauthCredentialsTestApi") as OAuthCredentialsTestApi).setFs(
    overrides,
  );
}

export function setGoogleOAuthSettingsFs(overrides?: Partial<OAuthSettingsFs>): void {
  (requireTestApi("openclaw.google.oauthSettingsTestApi") as OAuthSettingsTestApi).setFs(overrides);
}

export function resetGoogleVertexAdcState(): void {
  (requireTestApi("openclaw.google.vertexAdcTestApi") as VertexAdcTestApi).reset();
}
