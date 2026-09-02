import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import {
  mergeSkillLibrarySupportFiles,
  type SkillLibraryAuthoringCapability,
} from "../skills/library/authoring.js";
import { SkillLibraryError } from "../skills/library/errors.js";
import {
  listSkillLibrary,
  resolveSkillLibraryPresentation,
  readSkillLibrary,
  saveSkillLibrary,
  mutateSkillLibrary,
} from "../skills/library/service.js";
import { resolveSkillLibraryActor } from "../skills/library/store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { selectResolvedUserProfileById } from "../state/user-profiles-internal.js";
import {
  activateLibrarySelection,
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";

const active = new Map<string, Set<{ profileId: string; revoke: () => void }>>();

/** A mixed-person steer revokes mutation authority without changing the session's committed pins. */
export function invalidateSkillAuthoringForOtherRequester(
  sessionKey: string,
  profileId?: string,
): void {
  for (const grant of active.get(sessionKey) ?? []) {
    if (grant.profileId !== profileId) {
      const db = openOpenClawStateDatabase().db;
      if (
        !profileId ||
        selectResolvedUserProfileById(db, grant.profileId)?.id !==
          selectResolvedUserProfileById(db, profileId)?.id
      ) {
        grant.revoke();
      }
    }
  }
}

/** Only ordinary attributed human ingress may mint a namespace; actions remain normal tool policy. */
export function prepareGatewaySkillAuthoring(
  options: SkillLibraryRequestOwner,
  sessionKey: string,
  isHumanTurn: boolean,
): SkillLibraryAuthoringCapability | undefined {
  const client = options.client;
  if (
    !isHumanTurn ||
    !client?.authenticatedUserProfile ||
    client.internal?.syntheticClient ||
    client.internal?.agentRuntimeIdentity ||
    client.internal?.senderAttribution ||
    client.internal?.pluginRuntimeOwnerId ||
    client.internal?.approvalRuntime ||
    client.internal?.cronRunContinuation ||
    client.internal?.delegatedToolPolicyHandoffId
  ) {
    return undefined;
  }
  const authority = libraryAuthority(options);
  const library = resolveSkillLibraryPresentation(authority);
  if (!library.profileId || library.defaultTarget === "unavailable") {
    return undefined;
  }
  const profileId = library.profileId;
  invalidateSkillAuthoringForOtherRequester(sessionKey, profileId);
  let bound: AdmittedRunContext | undefined;
  let revoked = false;
  let owner: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
  const assertCurrent = () => {
    authority.assertCurrent();
    const caller = getGatewayToolCallerIdentity();
    if (
      revoked ||
      !bound ||
      !owner ||
      getAdmittedRunDelegatedAuthority(bound) !== owner ||
      caller?.operationalRunInstance !== bound.operationalRunInstance ||
      !caller.receiptAuthority ||
      caller.receiptAuthority() === false
    ) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Personal authoring authority expired or this turn has mixed requesters. Send a fresh attributed message requesting the change.",
      );
    }
  };
  const currentAuthority = { ...authority, assertCurrent, namespace: "personal" as const };
  return {
    target: "personal",
    defaultTarget: library.defaultTarget,
    multipleProfiles: library.multipleProfiles,
    bind(context) {
      if (bound) {
        if (context !== bound) {
          throw new SkillLibraryError(
            "AUTHORITY_EXPIRED",
            "Personal authoring cannot move to a replacement run. Send a fresh message.",
          );
        }
        return;
      }
      bound = context;
      owner = getAdmittedRunDelegatedAuthority(context);
      if (!owner) {
        throw new SkillLibraryError(
          "AUTHORITY_EXPIRED",
          "Personal authoring run was not admitted.",
        );
      }
      const grant = {
        profileId,
        revoke: () => {
          revoked = true;
        },
      };
      const grants = active.get(sessionKey) ?? new Set();
      grants.add(grant);
      active.set(sessionKey, grants);
      const stop = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
        if (closed !== owner) {
          return;
        }
        revoked = true;
        grants.delete(grant);
        if (!grants.size) {
          active.delete(sessionKey);
        }
        stop();
      });
    },
    assertWorkspaceCurrent() {
      assertCurrent();
      if (!resolveSkillLibraryActor(openOpenClawStateDatabase().db, authority).admin) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Workspace authoring requires current administrator authority.",
        );
      }
    },
    async invoke(input) {
      assertCurrent();
      if (input.action === "list") {
        return listSkillLibrary(currentAuthority);
      }
      if (input.action === "read") {
        if (!input.skillId) {
          throw new SkillLibraryError("INVALID_BUNDLE", "Choose skill_id from list.");
        }
        return readSkillLibrary(currentAuthority, input.skillId, input.revision);
      }
      if (input.action === "activate") {
        if (!input.skillId) {
          throw new SkillLibraryError("INVALID_BUNDLE", "Choose skill_id from list.");
        }
        return activateLibrarySelection(
          { ...options, sessionMutationCommitGuard: assertCurrent },
          { sessionKey, action: "attach", skillId: input.skillId, revision: input.revision },
        );
      }
      if (input.action !== "create" && (!input.skillId || !input.expectedRevision)) {
        throw new SkillLibraryError(
          "INVALID_BUNDLE",
          "Read the skill first; supply skill_id and expected_revision from that read.",
        );
      }
      if (input.action === "create" || input.action === "update") {
        const current =
          input.action === "update"
            ? await readSkillLibrary(currentAuthority, input.skillId!, input.expectedRevision)
            : undefined;
        const slug = input.slug ?? current?.entry.slug;
        const content = input.content ?? current?.content;
        if (!slug || !content) {
          throw new SkillLibraryError(
            "INVALID_BUNDLE",
            "Creating a skill requires name (the human slug) and complete proposal_content.",
          );
        }
        return saveSkillLibrary(currentAuthority, {
          slug,
          content,
          files: mergeSkillLibrarySupportFiles(
            current?.files ?? [],
            input.files,
            input.deleteFiles,
          ),
          skillId: input.action === "update" ? input.skillId : undefined,
          expectedRevision: input.action === "create" ? null : input.expectedRevision!,
        });
      }
      return mutateSkillLibrary(currentAuthority, {
        action: input.action,
        skillId: input.skillId!,
        expectedRevision: input.expectedRevision!,
        revision: input.revision,
      });
    },
  };
}
