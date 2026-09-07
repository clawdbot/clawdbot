// Native projection; scoped CLI-only sync remains in external-auth.ts.
import { nativePluginBindings } from "../../plugins/loader-runtime-load.js";
export const { listRuntimeExternalAuthProfiles, overlayExternalAuthProfiles } =
  nativePluginBindings.externalAuth;
