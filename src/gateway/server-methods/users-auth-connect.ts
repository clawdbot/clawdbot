import {
  ErrorCodes,
  errorShape,
  validateUsersAuthConnectCancelParams,
  validateUsersAuthConnectCompleteParams,
  validateUsersAuthConnectStartParams,
  validateUsersAuthConnectStatusParams,
  validateUsersAuthConnectTokenParams,
  validateUsersListModelAccountsParams,
  validateUsersSelectModelAccountParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { validateAnthropicSetupToken } from "../../plugins/provider-auth-token.js";
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
  requiredScope: "operator.read" | "operator.write" = "operator.write",
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
        service.start(action, options.params.provider),
      ),
  ),
  "users.authConnect.complete": defineValidatedGatewayMethod(
    "users.authConnect.complete",
    validateUsersAuthConnectCompleteParams,
    (options) => {
      registerSecretValueForRedaction(options.params.redirectInput);
      return runConnectRequest(options, options.params.profileId, (service, action) =>
        service.complete(action, options.params.connectId, options.params.redirectInput),
      );
    },
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
  "users.authConnect.token": defineValidatedGatewayMethod(
    "users.authConnect.token",
    validateUsersAuthConnectTokenParams,
    (options) => {
      registerSecretValueForRedaction(options.params.token);
      return runConnectRequest(options, options.params.profileId, (service, action) => {
        const token = options.params.token.trim();
        const invalidReason = validateAnthropicSetupToken(token);
        if (invalidReason) {
          throw new ModelAccountConnectInputError(invalidReason);
        }
        return service.token(action, { type: "token", provider: options.params.provider, token });
      });
    },
  ),
};
