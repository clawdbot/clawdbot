import {
  ErrorCodes,
  errorShape,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  registerProjectRegistry,
  removeProjectRegistry,
} from "../../projects/project-registry.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateProjectsListParams, "projects.list", respond)) {
      return;
    }
    const projects = listProjectRegistry(context.getRuntimeConfig());
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, scopes).allowed) {
      respond(true, { projects }, undefined);
      return;
    }
    // Project identity is read-safe; host paths and origins are placement
    // details reserved for clients that can create sessions.
    respond(
      true,
      {
        projects: projects.map((project) =>
          project.agentId
            ? {
                id: project.id,
                displayName: project.displayName,
                source: project.source,
                agentId: project.agentId,
              }
            : {
                id: project.id,
                displayName: project.displayName,
                source: project.source,
              },
        ),
      },
      undefined,
    );
  },
  "projects.register": async ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsRegisterParams, "projects.register", respond)) {
      return;
    }
    try {
      respond(
        true,
        await registerProjectRegistry({ path: params.path, name: params.name }),
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          error instanceof ProjectCheckoutError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
        ),
      );
    }
  },
  "projects.remove": ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsRemoveParams, "projects.remove", respond)) {
      return;
    }
    if (!removeProjectRegistry(params.id)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${params.id}`),
      );
      return;
    }
    respond(true, { removed: true }, undefined);
  },
};
