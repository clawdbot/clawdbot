import {
  ErrorCodes,
  errorShape,
  type ProtocolValidator,
  validateSkillsLibraryListParams,
  validateSkillsLibraryReadParams,
  validateSkillsLibrarySaveParams,
  validateSkillsLibraryMutateParams,
  validateSkillsLibraryActivateParams,
  validateSkillsLibraryImportParams,
  validateSkillsLibraryUploadParams,
  type SkillsLibraryActivateParams,
  type SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/index.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { SkillLibraryError } from "../../skills/library/errors.js";
import { importSkillLibrary, uploadSkillLibrary } from "../../skills/library/import.js";
import { changeSkillLibrarySelection } from "../../skills/library/selection.js";
import {
  listSkillLibrary,
  readSkillLibrary,
  saveSkillLibrary,
  mutateSkillLibrary,
} from "../../skills/library/service.js";
import {
  readSkillLibraryStore,
  selectSkillLibraryRow,
  projectSkillLibraryEntry,
  requireSkillLibraryEntry,
  selectSkillLibraryRevisionMetadata,
  type SkillLibraryAuthority,
} from "../../skills/library/store.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import {
  authorizeSessionSharingTarget,
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export type SkillLibraryRequestOwner = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "sessionMutationCommitGuard" | "sessionMutationAuthorization"
>;

export function libraryAuthority(options: SkillLibraryRequestOwner): SkillLibraryAuthority {
  const { client, context } = options;
  return {
    profileId: client?.authenticatedUserProfile?.profileId,
    scopes: client?.connect.scopes ?? [],
    getConfig: context.getRuntimeConfig,
    assertCurrent: () => {
      options.sessionMutationCommitGuard?.();
      options.sessionMutationAuthorization?.assertCurrent();
      // Synthetic agents must carry host-bound operator authority; identityless agents cannot publish.
      if (client?.internal?.syntheticClient) {
        throw new SkillLibraryError(
          "IDENTITY_REQUIRED",
          "Synthetic calls cannot acquire personal ownership. Ask the person to send a fresh attributed message or use My skills.",
        );
      }
    },
  };
}

export async function activateLibrarySelection(
  options: SkillLibraryRequestOwner,
  params: SkillsLibraryActivateParams,
) {
  const { client, context } = options;
  const authorization = resolveSessionMutationAuthorization({
    client,
    context,
    method: "skills.library.activate",
    requestParams: params,
  });
  if (authorization.error) {
    throw new SessionMutationAuthorizationChangedError(authorization.error);
  }
  const target = resolveSessionSharingTarget({
    cfg: context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
  });
  if (!target) {
    throw new SkillLibraryError("NOT_FOUND", "Session not found.");
  }
  const authority = libraryAuthority(options);
  let plannedSelections: SkillLibrarySelection[] | undefined;
  const assertCurrent = () => {
    authority.assertCurrent();
    authorization.authorization?.assertCurrent();
    if (plannedSelections && params.action !== "detach") {
      const checked = readSkillLibraryStore((db) => {
        for (const pin of plannedSelections!) {
          if (params.skillId && pin.skillId !== params.skillId) {
            continue;
          }
          const entry = requireSkillLibraryEntry(db, pin.skillId, authority);
          if (entry.removed || !selectSkillLibraryRevisionMetadata(db, pin.skillId, pin.revision)) {
            throw new SkillLibraryError(
              "CONFLICT",
              "Skill access changed during activation. Refresh the library and retry.",
            );
          }
        }
        return true;
      }, {});
      if (!checked) {
        throw new SkillLibraryError("CONFLICT", "Skill library changed during activation.");
      }
    }
    const current = resolveSessionSharingTarget({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
    });
    if (
      !current ||
      current.entry.sessionId !== target.entry.sessionId ||
      current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
      current.storePath !== target.storePath ||
      current.storeKey !== target.storeKey
    ) {
      throw new SkillLibraryError(
        "CONFLICT",
        "Session changed before activation; refresh and retry.",
      );
    }
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: current.entry,
      key: current.canonicalKey,
      pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
    });
    if (ownershipError) {
      throw new SessionMutationAuthorizationChangedError(ownershipError);
    }
  };
  const entry = await patchSessionEntryCore(
    { storePath: target.storePath, sessionKey: target.storeKey, agentId: target.agentId },
    (current) => {
      assertCurrent();
      const selections = changeSkillLibrarySelection(
        authority,
        current.skillLibrarySelections ?? [],
        params,
      );
      plannedSelections = selections;
      // Existing runs keep their prepared snapshot; the next turn rebuilds against the new pins.
      return { skillLibrarySelections: selections, updatedAt: Date.now() };
    },
    { assertCommitAllowed: assertCurrent },
  );
  if (!entry) {
    throw new SkillLibraryError(
      "CONFLICT",
      "Session changed before activation; refresh and retry.",
    );
  }
  return {
    sessionKey: target.canonicalKey,
    selections: entry.skillLibrarySelections ?? [],
    sessionActivation: "next-turn" as const,
  };
}

function selectedSession(options: SkillLibraryRequestOwner, sessionKey: string) {
  const resolve = () => {
    const cfg = options.context.getRuntimeConfig();
    const target = resolveSessionSharingTarget({ cfg, sessionKey });
    if (!target) {
      throw new SkillLibraryError("NOT_FOUND", "Session not found.");
    }
    const error = authorizeSessionSharingTarget({ cfg, client: options.client, target });
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
    return target;
  };
  const target = resolve();
  return {
    target,
    assertCurrent: () => {
      const current = resolve();
      if (
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
        JSON.stringify(current.entry.skillLibrarySelections) !==
          JSON.stringify(target.entry.skillLibrarySelections)
      ) {
        throw new SkillLibraryError("CONFLICT", "Session selection changed; refresh and retry.");
      }
    },
  };
}

function libraryHandler<P>(
  name: string,
  validate: ProtocolValidator<P>,
  run: (
    authority: SkillLibraryAuthority,
    params: P,
    options: GatewayRequestHandlerOptions,
  ) => unknown,
): GatewayRequestHandlers[string] {
  return async (options) => {
    if (!assertValidParams(options.params, validate, name, options.respond)) {
      return;
    }
    try {
      options.respond(
        true,
        await run(libraryAuthority(options), options.params, options),
        undefined,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        options.respond(false, undefined, error.error);
        return;
      }
      options.respond(
        false,
        undefined,
        error instanceof SkillLibraryError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
              details: {
                code: `SKILL_LIBRARY_${error.code}`,
                ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
              },
            })
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              "Unable to complete the skill library operation. Review the bundle or retry the request.",
            ),
      );
    }
  };
}

export const skillsLibraryHandlers: GatewayRequestHandlers = {
  "skills.library.list": libraryHandler(
    "skills.library.list",
    validateSkillsLibraryListParams,
    (authority, params, options) => {
      const session = params.sessionKey ? selectedSession(options, params.sessionKey) : undefined;
      const result = listSkillLibrary(authority, params);
      if (session) {
        const pins = session.target.entry.skillLibrarySelections ?? [];
        const selections =
          readSkillLibraryStore(
            (db) =>
              pins.map((pin) => {
                const row = selectSkillLibraryRow(db, pin.skillId);
                const entry =
                  row && projectSkillLibraryEntry(db, row, authority, pin.revision, true);
                if (!entry) {
                  throw new SkillLibraryError(
                    "NOT_FOUND",
                    "A pinned skill revision is unavailable. Restore the library or detach it explicitly.",
                  );
                }
                return {
                  ...pin,
                  slug: entry.slug,
                  description: entry.description,
                  ownerLabel: entry.ownerLabel,
                };
              }),
            {},
          ) ?? [];
        if (selections.length !== pins.length) {
          throw new SkillLibraryError(
            "NOT_FOUND",
            "Pinned skill library is unavailable. Restore it or detach the selected skills explicitly.",
          );
        }
        session.assertCurrent();
        result.session = {
          sessionKey: session.target.canonicalKey,
          selections,
          attachable: listSkillLibrary(authority).entries.filter(
            (entry) => !pins.some((pin) => pin.skillId === entry.skillId),
          ),
        };
      }
      return result;
    },
  ),
  "skills.library.read": libraryHandler(
    "skills.library.read",
    validateSkillsLibraryReadParams,
    (authority, params, options) => {
      if (!params.sessionKey) {
        return readSkillLibrary(authority, params.skillId, params.revision);
      }
      const session = selectedSession(options, params.sessionKey);
      const pin = session.target.entry.skillLibrarySelections?.find(
        (selection) =>
          selection.skillId === params.skillId && selection.revision === params.revision,
      );
      if (!pin) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Session reads require an exact selected skillId and revision.",
        );
      }
      return readSkillLibrary(
        authority,
        params.skillId,
        params.revision,
        {},
        { revision: pin.revision, assertSessionAccess: session.assertCurrent },
      );
    },
  ),
  "skills.library.save": libraryHandler(
    "skills.library.save",
    validateSkillsLibrarySaveParams,
    (authority, params) => saveSkillLibrary(authority, params),
  ),
  "skills.library.mutate": libraryHandler(
    "skills.library.mutate",
    validateSkillsLibraryMutateParams,
    (authority, params) => mutateSkillLibrary(authority, params),
  ),
  "skills.library.activate": libraryHandler(
    "skills.library.activate",
    validateSkillsLibraryActivateParams,
    (_authority, params, options) => activateLibrarySelection(options, params),
  ),
  "skills.library.import": libraryHandler(
    "skills.library.import",
    validateSkillsLibraryImportParams,
    (authority, params) => importSkillLibrary(authority, params),
  ),
  "skills.library.upload": libraryHandler(
    "skills.library.upload",
    validateSkillsLibraryUploadParams,
    (authority, params) => uploadSkillLibrary(authority, params),
  ),
};
