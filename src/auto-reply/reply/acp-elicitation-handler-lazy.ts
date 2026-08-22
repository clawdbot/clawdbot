import type { AcpElicitationHandler } from "@openclaw/acp-core/runtime/types";
import type { AcpElicitationHandlerParams } from "./acp-elicitation-handler.js";

/** Defers the structured-input stack while preserving one exact handler per turn. */
export function createLazyAcpElicitationHandler(
  params: AcpElicitationHandlerParams,
): AcpElicitationHandler {
  let handler: Promise<AcpElicitationHandler> | undefined;
  return async (request, context) => {
    handler ??= import("./acp-elicitation-handler.js").then(({ createAcpElicitationHandler }) =>
      createAcpElicitationHandler(params),
    );
    return (await handler)(request, context);
  };
}
