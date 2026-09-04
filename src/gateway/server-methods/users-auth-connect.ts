import {
  ErrorCodes,
  errorShape,
  validateUsersAuthConnectCancelParams,
  validateUsersAuthConnectAnswerParams,
  validateUsersAuthConnectStartParams,
  validateUsersAuthConnectStatusParams,
  validateUsersAuthConnectCatalogParams,
  validateUsersListAuthLinksParams,
  validateUsersLinkAuthProfileParams,
  validateUsersUnlinkAuthProfileParams,
  validateUsersListModelAccountsParams,
  validateUsersSelectModelAccountParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { UserProfileNotFoundError } from "../../state/user-profiles.js";
import type { ModelAccountConnectAction } from "../model-account-authority.js";
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
} from "../model-account-connect.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { prepareUserModelAccountAction } from "./users-model-account-access.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type ConnectRequest = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "respond"
>;

function runConnectRequest(
  options: ConnectRequest,
  profileId: string | undefined,
  run: (
    service: NonNullable<GatewayRequestContext["modelAccountConnectService"]>,
    action: ModelAccountConnectAction,
  ) => unknown,
  requiredScope: "operator.read" | "operator.write" | "operator.admin" = "operator.write",
): void | Promise<void> {
  const fail = (error: unknown) => {
    const responseError =
      error instanceof ModelAccountConnectAuthorityError
        ? errorShape(ErrorCodes.FORBIDDEN, error.message)
        : error instanceof ModelAccountConnectInputError ||
            error instanceof UserProfileNotFoundError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message)
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              "Model account connect is unavailable right now; try again shortly.",
            );
    options.respond(false, undefined, responseError);
  };
  try {
    const action = prepareUserModelAccountAction(options, profileId, requiredScope);
    const service = options.context.modelAccountConnectService;
    if (!service) {
      throw new Error("Model-account service is not running.");
    }
    const result = run(service, action);
    if (result instanceof Promise) {
      return result.then((value) => options.respond(true, value)).catch(fail);
    }
    options.respond(true, result);
  } catch (error) {
    fail(error);
  }
}

export const usersAuthConnectHandlers: GatewayRequestHandlers = {
  "users.listAuthLinks": defineValidatedGatewayMethod(
    "users.listAuthLinks",
    validateUsersListAuthLinksParams,
    (options) =>
      runConnectRequest(
        options,
        options.params.profileId,
        (service, action) => service.listLinks(action),
        "operator.read",
      ),
  ),
  "users.linkAuthProfile": defineValidatedGatewayMethod(
    "users.linkAuthProfile",
    validateUsersLinkAuthProfileParams,
    (options) =>
      runConnectRequest(
        options,
        options.params.profileId,
        (service, action) => service.link(action, options.params.authProfileId),
        // Choosing an existing shared credential remains an explicit admin decision.
        "operator.admin",
      ),
  ),
  "users.unlinkAuthProfile": defineValidatedGatewayMethod(
    "users.unlinkAuthProfile",
    validateUsersUnlinkAuthProfileParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.unlink(action, options.params.provider),
      ),
  ),
  "users.listModelAccounts": defineValidatedGatewayMethod(
    "users.listModelAccounts",
    validateUsersListModelAccountsParams,
    (options) =>
      runConnectRequest(
        options,
        options.params.profileId,
        (service, action) => service.list(action, options.params.cursor),
        "operator.read",
      ),
  ),
  "users.selectModelAccount": defineValidatedGatewayMethod(
    "users.selectModelAccount",
    validateUsersSelectModelAccountParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.select(action, options.params.authProfileId),
      ),
  ),
  "users.authConnect.start": defineValidatedGatewayMethod(
    "users.authConnect.start",
    validateUsersAuthConnectStartParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.start(action, options.params.provider, options.params.method),
      ),
  ),
  "users.authConnect.answer": defineValidatedGatewayMethod(
    "users.authConnect.answer",
    validateUsersAuthConnectAnswerParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.answer(
          action,
          options.params.connectId,
          options.params.stepId,
          options.params.value,
        ),
      ),
  ),
  "users.authConnect.status": defineValidatedGatewayMethod(
    "users.authConnect.status",
    validateUsersAuthConnectStatusParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.status(action, options.params.connectId),
      ),
  ),
  "users.authConnect.cancel": defineValidatedGatewayMethod(
    "users.authConnect.cancel",
    validateUsersAuthConnectCancelParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.cancel(action, options.params.connectId),
      ),
  ),
  "users.authConnect.catalog": defineValidatedGatewayMethod(
    "users.authConnect.catalog",
    validateUsersAuthConnectCatalogParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.catalog(action),
      ),
  ),
};
