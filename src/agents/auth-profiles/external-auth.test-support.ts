import "./external-auth.js";

type ResolveExternalAuthProfiles =
  typeof import("../../plugins/provider-runtime.js").resolveExternalAuthProfilesWithPlugins;

type ExternalAuthTestApi = {
  resetResolveExternalAuthProfilesForTest(): void;
  setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void;
};

function getTestApi(): ExternalAuthTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.externalAuthTestApi")
  ] as ExternalAuthTestApi;
}

export const testing: ExternalAuthTestApi = {
  resetResolveExternalAuthProfilesForTest: () =>
    getTestApi().resetResolveExternalAuthProfilesForTest(),
  setResolveExternalAuthProfilesForTest: (resolver) =>
    getTestApi().setResolveExternalAuthProfilesForTest(resolver),
};
