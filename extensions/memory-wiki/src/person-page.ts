import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WikiPageSummary } from "./markdown.js";

export function isPersonLikePage(
  page: Pick<WikiPageSummary, "entityType" | "pageType" | "personCard">,
): boolean {
  const entityType = normalizeLowercaseStringOrEmpty(page.entityType);
  const pageType = normalizeLowercaseStringOrEmpty(page.pageType);
  return (
    Boolean(page.personCard) ||
    entityType === "person" ||
    entityType === "maintainer" ||
    pageType === "person" ||
    pageType === "maintainer"
  );
}
