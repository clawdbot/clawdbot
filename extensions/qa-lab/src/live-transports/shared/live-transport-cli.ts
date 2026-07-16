// Qa Lab plugin module implements live transport cli behavior.
import {
  createLiveTransportQaCliRegistration as createSharedLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistrationOptions,
} from "openclaw/plugin-sdk/qa-runtime";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, formatQaProviderModeHelp } from "../../providers/index.js";

export {
  createLazyCliRuntimeLoader,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "openclaw/plugin-sdk/qa-runtime";

type QaLabLiveTransportQaCliRegistrationOptions = Omit<
  LiveTransportQaCliRegistrationOptions,
  "allowFailuresHelp" | "defaultProviderMode" | "providerModeHelp"
> & {
  defaultProviderMode?: LiveTransportQaCliRegistrationOptions["defaultProviderMode"];
};

export function createLiveTransportQaCliRegistration(
  params: QaLabLiveTransportQaCliRegistrationOptions,
) {
  return createSharedLiveTransportQaCliRegistration({
    ...params,
    allowFailuresHelp: "Write artifacts without setting a failing exit code when scenarios fail",
    defaultProviderMode: params.defaultProviderMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
    providerModeHelp: formatQaProviderModeHelp(),
  });
}
