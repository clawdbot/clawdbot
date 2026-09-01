// Slack canvas operations, split from actions.ts to keep that file under the
// repo max-lines limit. Re-exported by actions.ts so the lazy action-runtime
// module loader resolves them through the actions.js barrel.
//
// Slack Canvas is a channel-scoped collaborative document surface. The Web API
// family is `canvases.create` / `canvases.edit` / `canvases.delete` /
// `canvases.sections.lookup` (verified against a real workspace; the singular
// `canvas.*` names and `canvases.access`/`canvases.sections.update`/
// `canvases.sections.delete` do not exist). `@slack/web-api` does not ship
// typed methods for this family, so calls go through the generic `apiCall`.
import { getClient, type SlackActionClientOpts } from "./actions-client.js";

// Slack canvas IDs are encoded as `F` followed by 8+ uppercase alphanumerics
// (the same regex the Slack API enforces server-side on canvas_id). Validating
// at the owner boundary rejects malformed or cross-surface IDs before any HTTP
// call — a canvas ID alone does not prove the agent may touch that document, so
// the dispatch layer still authorizes the owning channel via read-target gates.
const SLACK_CANVAS_ID_PATTERN = /^[F][A-Z0-9]{8,}$/;

export type SlackCanvasDocumentContent = {
  type: "markdown";
  markdown: string;
};

export type SlackCanvasSection = {
  id?: string;
};

export function assertCanvasId(canvasId: string): void {
  if (!SLACK_CANVAS_ID_PATTERN.test(canvasId)) {
    throw new Error(
      `Invalid Slack canvas id "${canvasId}": expected an F-prefixed canvas id (for example F0BU46ESS8J).`,
    );
  }
}

// Slack caps each canvas change's markdown at 1 MiB; normalize the caller's
// document content into the wire shape and reject empty markdown early so the
// API does not return a less actionable invalid_arguments error.
function normalizeCanvasDocumentContent(
  content: SlackCanvasDocumentContent,
): Record<string, unknown> {
  const markdown = content.markdown ?? "";
  if (!markdown) {
    throw new Error("Slack canvas document content markdown is required.");
  }
  return { type: "markdown", markdown };
}

export async function createSlackCanvas(
  channelId: string,
  opts: SlackActionClientOpts & {
    title?: string;
    documentContent?: SlackCanvasDocumentContent;
  } = {},
): Promise<{ canvasId: string }> {
  const client = await getClient(opts, "write");
  // Free Slack teams cannot create standalone canvases; a channel_id attaches
  // the canvas to an allowlisted channel, which is the durable document surface
  // this action targets. Require it so the call succeeds across plan tiers.
  const result = await client.apiCall("canvases.create", {
    channel_id: channelId,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.documentContent
      ? { document_content: normalizeCanvasDocumentContent(opts.documentContent) }
      : {}),
  });
  // SAFETY: apiCall returns `unknown`; canvas_id is validated as a non-empty string below before use.
  const canvasId = (result as { canvas_id?: unknown }).canvas_id;
  if (typeof canvasId !== "string" || !canvasId) {
    throw new Error("Slack canvases.create did not return a canvas_id.");
  }
  return { canvasId };
}

export async function editSlackCanvas(
  canvasId: string,
  changes: readonly SlackCanvasChange[],
  opts: SlackActionClientOpts = {},
): Promise<void> {
  assertCanvasId(canvasId);
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error("Slack canvases.edit requires at least one change.");
  }
  const client = await getClient(opts, "write");
  const wireChanges = changes.map((change) => normalizeCanvasChange(change));
  await client.apiCall("canvases.edit", {
    canvas_id: canvasId,
    changes: wireChanges,
  });
}

export async function deleteSlackCanvas(
  canvasId: string,
  opts: SlackActionClientOpts = {},
): Promise<void> {
  assertCanvasId(canvasId);
  const client = await getClient(opts, "write");
  await client.apiCall("canvases.delete", { canvas_id: canvasId });
}

export async function lookupSlackCanvasSections(
  canvasId: string,
  opts: SlackActionClientOpts & {
    sectionTypes?: readonly string[];
    containsText?: string;
    limit?: number;
  } = {},
): Promise<{ sections: SlackCanvasSection[] }> {
  assertCanvasId(canvasId);
  const client = await getClient(opts, "read");
  const criteria: Record<string, unknown> = {};
  if (opts.sectionTypes && opts.sectionTypes.length > 0) {
    criteria.section_types = opts.sectionTypes;
  }
  if (opts.containsText) {
    criteria.contains_text = opts.containsText;
  }
  if (Object.keys(criteria).length === 0) {
    throw new Error(
      "Slack canvases.sections.lookup requires sectionTypes or containsText criteria.",
    );
  }
  const result = await client.apiCall("canvases.sections.lookup", {
    canvas_id: canvasId,
    criteria,
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  // SAFETY: apiCall returns `unknown`; sections is narrowed via Array.isArray before the SlackCanvasSection[] cast, so non-array shapes yield [].
  const sections = (result as { sections?: unknown }).sections;
  return { sections: Array.isArray(sections) ? (sections as SlackCanvasSection[]) : [] }; // SAFETY: guarded by Array.isArray above; SlackCanvasSection is a structural {id?} subset of the runtime array elements.
}

// `canvases.edit` changes are discriminated by `operation`; each operation
// requires a specific field set (document_content vs title_content vs
// section_id). Normalize at the owner boundary so callers cannot build a
// change the Slack API would reject with an opaque invalid_arguments error.
export type SlackCanvasChange =
  | {
      operation: "insert_at_start" | "insert_at_end";
      documentContent: SlackCanvasDocumentContent;
    }
  | {
      operation: "insert_after" | "insert_before" | "delete";
      sectionId: string;
      documentContent?: SlackCanvasDocumentContent;
    }
  | {
      operation: "replace";
      documentContent: SlackCanvasDocumentContent;
      sectionId?: string;
    }
  | {
      operation: "rename";
      titleContent: SlackCanvasDocumentContent;
    };

function normalizeCanvasChange(change: SlackCanvasChange): Record<string, unknown> {
  switch (change.operation) {
    case "insert_at_start":
    case "insert_at_end":
      return {
        operation: change.operation,
        document_content: normalizeCanvasDocumentContent(change.documentContent),
      };
    case "insert_after":
    case "insert_before":
      if (!change.documentContent) {
        throw new Error(`Slack canvas ${change.operation} requires documentContent.`);
      }
      return {
        operation: change.operation,
        section_id: change.sectionId,
        document_content: normalizeCanvasDocumentContent(change.documentContent),
      };
    case "delete":
      return { operation: change.operation, section_id: change.sectionId };
    case "replace":
      return {
        operation: change.operation,
        document_content: normalizeCanvasDocumentContent(change.documentContent),
        ...(change.sectionId ? { section_id: change.sectionId } : {}),
      };
    case "rename":
      return {
        operation: change.operation,
        title_content: normalizeCanvasDocumentContent(change.titleContent),
      };
    default: {
      const exhaustive: never = change;
      throw new Error(`Unsupported Slack canvas change: ${JSON.stringify(exhaustive)}`);
    }
  }
}
