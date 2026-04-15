export const EXISTING_SESSION_LIMITS = {
  act: {
    clickSelector: "existing-session click does not support selector targeting yet; use ref.",
    clickButtonOrModifiers:
      "existing-session click currently supports left-click only (no button overrides/modifiers).",
    typeSelector: "existing-session type does not support selector targeting yet; use ref.",
    typeSlowly: "existing-session type does not support slowly=true; use fill/press instead.",
    pressDelay: "existing-session press does not support delayMs.",
    hoverSelector: "existing-session hover does not support selector targeting yet; use ref.",
    hoverTimeout: "existing-session hover does not support timeoutMs overrides.",
    scrollSelector:
      "existing-session scrollIntoView does not support selector targeting yet; use ref.",
    scrollTimeout: "existing-session scrollIntoView does not support timeoutMs overrides.",
    dragSelector:
      "existing-session drag does not support selector targeting yet; use startRef/endRef.",
    dragTimeout: "existing-session drag does not support timeoutMs overrides.",
    selectSelector: "existing-session select does not support selector targeting yet; use ref.",
    selectSingleValue: "existing-session select currently supports a single value only.",
    selectTimeout: "existing-session select does not support timeoutMs overrides.",
    fillTimeout: "existing-session fill does not support timeoutMs overrides.",
    waitNetworkIdle: "existing-session wait does not support loadState=networkidle yet.",
    evaluateTimeout: "existing-session evaluate does not support timeoutMs overrides.",
    batch: "existing-session batch is not supported yet; send actions individually.",
  },
  hooks: {
    uploadElement:
      "existing-session file uploads do not support element selectors; use ref/inputRef.",
    uploadSingleFile: "existing-session file uploads currently support one file at a time.",
    uploadRefRequired: "existing-session file uploads require ref or inputRef.",
    dialogTimeout: "existing-session dialog handling does not support timeoutMs.",
  },
  download: {
    waitUnsupported: "download waiting is not supported for existing-session profiles yet.",
    downloadUnsupported: "downloads are not supported for existing-session profiles yet.",
  },
  snapshot: {
    pdfUnsupported:
      "pdf is not supported for existing-session profiles yet; use screenshot/snapshot instead.",
    screenshotElement:
      "element screenshots are not supported for existing-session profiles; use ref from snapshot.",
    snapshotSelector:
      "selector/frame snapshots are not supported for existing-session profiles; snapshot the whole page and use refs.",
  },
  responseBody: "response body is not supported for existing-session profiles yet.",
} as const;
