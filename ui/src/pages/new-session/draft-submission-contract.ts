import type { ApplicationContext } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";

export type DraftSubmissionSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected: boolean;
}>;

export type DraftSubmissionCallbacks = {
  takePreparedTitle?: () => string | undefined;
  requestUpdate: () => void;
  closeTransientUi: () => void;
};
