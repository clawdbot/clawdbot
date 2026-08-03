// Stores process-global CLI flags shared by command modules.
let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}
