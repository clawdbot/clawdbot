import { CONTROL_UI_DOCUMENT_ROUTE_PATHS, normalizeBasePath } from "../app-route-paths.ts";

type ApprovalDocumentMode = {
  kind: "approval";
  approvalId: string | null;
};

type QuestionDocumentMode = {
  kind: "question";
  questionId: string | null;
};

export type ControlUiDocumentMode = ApprovalDocumentMode | QuestionDocumentMode;

/**
 * Recognizes shellless documents before the exact-path app router can replace
 * them with Chat. Gateway owners validate decoded ids; this parser preserves
 * the one-segment URL contract and rejects ambiguous paths.
 */
function resolveDocumentId(
  pathname: string,
  basePath: string,
  routePath: string,
): string | null | undefined {
  const normalizedBasePath = normalizeBasePath(basePath);
  const documentRoot = `${normalizedBasePath}${routePath}`;
  if (pathname === documentRoot || pathname === `${documentRoot}/`) {
    return null;
  }
  const prefix = `${documentRoot}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const encodedId = pathname.slice(prefix.length);
  if (!encodedId || encodedId.includes("/")) {
    return null;
  }
  try {
    const documentId = decodeURIComponent(encodedId);
    return documentId && documentId !== "." && documentId !== ".." ? documentId : null;
  } catch {
    return null;
  }
}

function resolveApprovalDocumentMode(
  pathname: string,
  basePath: string,
): ApprovalDocumentMode | null {
  const approvalId = resolveDocumentId(
    pathname,
    basePath,
    CONTROL_UI_DOCUMENT_ROUTE_PATHS.approval,
  );
  return approvalId === undefined ? null : { kind: "approval", approvalId };
}

function resolveQuestionDocumentMode(
  pathname: string,
  basePath: string,
): QuestionDocumentMode | null {
  const questionId = resolveDocumentId(
    pathname,
    basePath,
    CONTROL_UI_DOCUMENT_ROUTE_PATHS.question,
  );
  return questionId === undefined ? null : { kind: "question", questionId };
}

export function resolveControlUiDocumentMode(
  pathname: string,
  basePath: string,
): ControlUiDocumentMode | null {
  return (
    resolveApprovalDocumentMode(pathname, basePath) ??
    resolveQuestionDocumentMode(pathname, basePath)
  );
}
