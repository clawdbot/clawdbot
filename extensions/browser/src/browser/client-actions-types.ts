export type BrowserActionOk = { ok: true };

export type BrowserActionTabResult = {
  ok: true;
  targetId: string;
  url?: string;
};

export type BrowserActionPathResult = {
  ok: true;
  path: string;
  targetId: string;
  url?: string;
};

export type BrowserActionTargetOk = { ok: true; targetId: string };
