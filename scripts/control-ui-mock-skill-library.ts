import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../packages/gateway-protocol/src/index.ts";
import type { ModelCatalogEntry } from "../ui/src/api/types.ts";
import type {
  ControlUiMockGateway,
  ControlUiMockRequestHandler,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../ui/src/test-helpers/skill-library-fixtures.ts";

/** Runs inside the isolated mock browser, after the generic Gateway fixture. */
function installSkillLibraryMock(
  seed: ReturnType<typeof buildSkillLibraryMock>,
  models: ModelCatalogEntry[],
): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const mode = new URL(window.location.href).searchParams.get("skillLibrary") ?? "shared";
  const solo = mode === "solo";
  const viewer = mode === "collaborator" ? "profile-bob" : "profile-alice";
  const entries = new Map(seed.map((read) => [read.entry.skillId, read]));
  const histories = new Map(
    seed.map((read) => [
      read.entry.skillId,
      new Map([[read.entry.revision, structuredClone(read)]]),
    ]),
  );
  const sessions = new Map<string, SkillsLibraryReadResult[]>();
  const uploads = new Map<string, { slug: string; offset: number }>();
  const pins = (sessionKey: string) => {
    let selected = sessions.get(sessionKey);
    if (!selected) {
      selected = mode === "collaborator" ? [structuredClone(seed[0])] : [];
      sessions.set(sessionKey, selected);
    }
    return selected;
  };
  const visible = () =>
    solo
      ? []
      : Array.from(entries.values())
          .map((read) => read.entry)
          .filter(
            (entry) =>
              !entry.removed &&
              (mode === "admin" ||
                entry.ownerProfileId === viewer ||
                entry.shared ||
                entry.ownerProfileId === null),
          );
  const selection = (read: SkillsLibraryReadResult) => ({
    skillId: read.entry.skillId,
    revision: read.entry.revision,
    name: read.entry.name,
    ownerProfileId: read.entry.ownerProfileId,
    slug: read.entry.slug,
    description: read.entry.description,
    ownerLabel: read.entry.ownerLabel,
  });
  const list = (sessionKey?: string): SkillsLibraryListResult => {
    const selected = sessionKey ? pins(sessionKey) : [];
    return {
      entries: visible(),
      profileId: solo ? null : viewer,
      multipleProfiles: !solo,
      defaultTarget: solo ? "workspace" : "personal",
      canManageWorkspace: solo || mode === "admin",
      defaultSelectionLimit: 64,
      ...(sessionKey
        ? {
            session: {
              sessionKey,
              selections: selected.map(selection),
              attachable: visible().filter(
                (entry) => !selected.some((read) => read.entry.skillId === entry.skillId),
              ),
            },
          }
        : {}),
    };
  };
  for (const read of entries.values()) {
    read.entry.canEdit =
      mode !== "readonly" && (mode === "admin" || read.entry.ownerProfileId === viewer);
  }
  const handleRequest = (
    method: string,
    { params: input, respond }: Parameters<ControlUiMockRequestHandler>[0],
  ) => {
    const params = (input ?? {}) as {
      sessionKey?: string;
      skillId?: string;
      expectedRevision?: string | null;
      slug?: string;
      content?: string;
      files?: SkillsLibraryReadResult["files"];
      action?: string;
      revision?: string;
      source?: { slug: string };
      uploadId?: string;
      offset?: number;
      data?: string;
      sizeBytes?: number;
      sha256?: string;
    };
    if (method === "commands.list" || method === "chat.metadata") {
      const selected = params.sessionKey ? pins(params.sessionKey) : [];
      respond({
        commands: selected.map(({ entry }) => ({
          name: entry.name,
          skillDisplayName: `${entry.slug} · ${entry.ownerLabel}`,
          description: entry.description,
          source: "skill",
          scope: "both",
          acceptsArgs: true,
          skillModelVisible: true,
          textAliases: [`/${entry.name}`],
        })),
        ...(method === "chat.metadata" ? { models } : {}),
      });
      return;
    }
    const reject = (message: string, code = "SKILL_LIBRARY_FORBIDDEN") => {
      respond({ __mockError: { code: "INVALID_REQUEST", message, details: { code } } });
    };
    if (method === "skills.library.list") {
      respond(list(params.sessionKey));
      return;
    }
    if (method === "skills.library.read") {
      const selected = params.sessionKey
        ? pins(params.sessionKey).find(
            (read) =>
              read.entry.skillId === params.skillId && read.entry.revision === params.revision,
          )
        : undefined;
      const read = params.sessionKey
        ? selected
        : params.skillId && visible().some((entry) => entry.skillId === params.skillId)
          ? params.revision
            ? histories.get(params.skillId)?.get(params.revision)
            : entries.get(params.skillId)
          : undefined;
      if (!read) {
        return reject("Read requires visible library access or an exact selected session pin.");
      }
      respond(
        params.sessionKey
          ? {
              ...read,
              entry: { ...read.entry, canEdit: false },
              revisions: [{ revision: read.entry.revision, createdAt: read.entry.updatedAt }],
            }
          : {
              ...read,
              entry: {
                ...read.entry,
                canEdit: entries.get(read.entry.skillId)?.entry.canEdit === true,
              },
            },
      );
      return;
    }
    if (method === "skills.library.activate") {
      if (!params.sessionKey) {
        return reject("Activation requires a session key.");
      }
      const selected = pins(params.sessionKey);
      const targets =
        params.action === "refresh" && !params.skillId
          ? selected.map((read) => read.entry.skillId)
          : [params.skillId];
      if (
        params.action !== "detach" &&
        targets.some((id) => !visible().some((entry) => entry.skillId === id))
      ) {
        return reject(
          "Refresh requires current library access. The existing session pin remains unchanged.",
        );
      }
      let next = selected.filter((read) => read.entry.skillId !== params.skillId);
      if (params.action === "refresh" && !params.skillId) {
        next = [];
      }
      if (params.action !== "detach") {
        for (const id of targets) {
          const read = id
            ? params.revision
              ? histories.get(id)?.get(params.revision)
              : entries.get(id)
            : undefined;
          if (!read) {
            return reject("Skill revision is unavailable.");
          }
          next.push(structuredClone(read));
        }
      }
      sessions.set(params.sessionKey, next);
      respond({
        sessionKey: params.sessionKey,
        selections: next.map((read) => ({
          skillId: read.entry.skillId,
          revision: read.entry.revision,
          name: read.entry.name,
          ownerProfileId: read.entry.ownerProfileId,
        })),
        sessionActivation: "next-turn",
      });
      return;
    }
    if (method === "skills.library.upload") {
      if (params.action === "begin" && params.slug && params.sizeBytes && params.sha256) {
        const uploadId = `mock-upload-${params.slug}`;
        uploads.set(uploadId, { slug: params.slug, offset: 0 });
        respond({ uploadId, offset: 0, maxChunkBytes: 256 * 1024 });
        return;
      }
      const upload = params.uploadId ? uploads.get(params.uploadId) : undefined;
      if (!upload) {
        return reject("The mock upload is no longer available.", "SKILL_LIBRARY_UPLOAD_MISSING");
      }
      if (params.action === "chunk" && typeof params.data === "string") {
        const received = atob(params.data).length;
        upload.offset = (params.offset ?? upload.offset) + received;
        respond({ uploadId: params.uploadId, offset: upload.offset, maxChunkBytes: 256 * 1024 });
        return;
      }
      if (params.action === "commit") {
        uploads.delete(params.uploadId ?? "");
        respond({
          state: "published",
          target: "personal",
          entry: {
            skillId: `mock-uploaded-${upload.slug}`,
            slug: upload.slug,
            name: `s_${upload.slug.replaceAll("-", "_").slice(0, 24)}`,
            description: "Imported archive fixture",
            ownerProfileId: viewer,
            ownerLabel: viewer === "profile-alice" ? "Alice" : "Bob",
            authorProfileId: viewer,
            shared: false,
            enabled: true,
            removed: false,
            revision: "f".repeat(64),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            canEdit: true,
          },
          sessionActivation: "new-sessions",
          nextAction: "Imported for new sessions; attach it explicitly to use it here.",
        });
        return;
      }
    }
    const current = params.skillId ? entries.get(params.skillId) : undefined;
    if (
      params.skillId &&
      (!current ||
        !current.entry.canEdit ||
        current.entry.revision !== params.expectedRevision ||
        mode === "conflict")
    ) {
      return reject(
        "The skill changed. Reopen it to review the latest revision.",
        "SKILL_LIBRARY_CONFLICT",
      );
    }
    const skillId = current?.entry.skillId ?? crypto.randomUUID();
    const slug = params.slug ?? current?.entry.slug ?? "imported-skill";
    const revision =
      method === "skills.library.mutate"
        ? ((params.action === "rollback" ? params.revision : current?.entry.revision) ??
          "1".repeat(64))
        : String((current?.revisions.length ?? 0) + 1).padStart(64, "0");
    const previous =
      params.action === "rollback" && params.revision
        ? histories.get(skillId)?.get(params.revision)
        : undefined;
    const read: SkillsLibraryReadResult = current ?? {
      entry: {
        skillId,
        slug,
        name: `s_${slug.replaceAll("-", "_").slice(0, 9)}_${skillId.replaceAll("-", "").slice(0, 20)}`,
        description: "Custom skill",
        ownerProfileId: viewer,
        ownerLabel: viewer === "profile-alice" ? "Alice" : "Bob",
        authorProfileId: viewer,
        shared: false,
        enabled: true,
        removed: false,
        revision,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        canEdit: true,
      },
      content: "",
      files: [],
      revisions: [],
    };
    read.entry = { ...read.entry, slug, revision, updatedAt: Date.now() };
    if (method === "skills.library.save") {
      read.content = params.content ?? "";
      read.files = params.files ?? [];
    }
    if (method === "skills.library.import") {
      read.content = `---\nname: ${slug}\ndescription: Imported from ClawHub\n---\n\nImported ${params.source?.slug ?? slug}.\n`;
    }
    if (params.action === "remove") {
      read.entry.removed = true;
    }
    if (params.action === "share" || params.action === "unshare") {
      read.entry.shared = params.action === "share";
    }
    if (params.action === "enable" || params.action === "disable") {
      read.entry.enabled = params.action === "enable";
    }
    if (params.action === "transfer") {
      read.entry.ownerProfileId = null;
      read.entry.ownerLabel = "Team";
      read.entry.shared = true;
    }
    if (previous) {
      read.content = previous.content;
      read.files = structuredClone(previous.files);
    }
    if (!read.revisions.some((item) => item.revision === revision)) {
      read.revisions = [{ revision, createdAt: Date.now() }, ...read.revisions];
    }
    entries.set(skillId, read);
    const history = histories.get(skillId) ?? new Map();
    history.set(revision, structuredClone(read));
    histories.set(skillId, history);
    respond({
      state: read.entry.removed ? "removed" : "published",
      target: read.entry.ownerProfileId === null ? "team" : "personal",
      entry: read.entry,
      sessionActivation: "new-sessions",
      nextAction: read.entry.removed
        ? "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions."
        : !read.entry.enabled
          ? "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available."
          : `Enabled for ${read.entry.shared || read.entry.ownerProfileId === null ? "new team sessions" : "your new sessions"}, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.`,
    });
  };
  for (const method of [
    "commands.list",
    "chat.metadata",
    "skills.library.list",
    "skills.library.read",
    "skills.library.activate",
    "skills.library.save",
    "skills.library.mutate",
    "skills.library.import",
    "skills.library.upload",
  ]) {
    gateway.setRequestHandler(method, (request) => handleRequest(method, request));
  }
}

export function skillLibraryMockInitScript(models: ModelCatalogEntry[] = []): string {
  return `(() => { const __name = (target) => target; (${installSkillLibraryMock.toString()})(${JSON.stringify(buildSkillLibraryMock())}, ${JSON.stringify(models)}); })();`;
}
