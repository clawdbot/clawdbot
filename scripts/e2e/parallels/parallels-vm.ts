import { die, run, say, warn } from "./host-command.ts";

interface PrlctlVmListItem {
  name?: string;
  status?: string;
}

export function listVmNames(): string[] {
  return listVms()
    .map((item) => (item.name ?? "").trim())
    .filter(Boolean);
}

export function vmStatus(vmName: string): string {
  return listVms().find((vm) => vm.name === vmName)?.status || "missing";
}

export function waitForVmStatus(vmName: string, expected: string, timeoutSeconds: number): void {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const status = run("prlctl", ["status", vmName], {
      check: false,
      quiet: true,
    }).stdout;
    if (status.includes(` ${expected}`)) {
      return;
    }
    run("sleep", ["1"], { quiet: true });
  }
  throw new Error(`VM ${vmName} did not reach ${expected}`);
}

export function ensureVmRunning(vmName: string, timeoutSeconds = 180): void {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const status = vmStatus(vmName);
    if (status === "running") {
      return;
    }
    if (status === "stopped") {
      say(`Start ${vmName} before update phase`);
      run("prlctl", ["start", vmName], { quiet: true });
    } else if (status === "suspended" || status === "paused") {
      say(`Resume ${vmName} before update phase`);
      run("prlctl", ["resume", vmName], { quiet: true });
    } else if (status === "missing") {
      die(`VM not found before update phase: ${vmName}`);
    }
    run("sleep", ["5"], { quiet: true });
  }
  die(`VM did not become running before update phase: ${vmName}`);
}

export function resolveUbuntuVmName(requested: string, explicit = false): string {
  const names = listVmNames();
  if (names.includes(requested)) {
    return requested;
  }
  if (explicit) {
    die(`VM not found: ${requested}`);
  }
  const fallback =
    names
      .map((name) => ({ name, version: /ubuntu\s+(\d+(?:\.\d+)*)/i.exec(name)?.[1] }))
      .filter((item): item is { name: string; version: string } => Boolean(item.version))
      .map((item) => ({
        name: item.name,
        parts: item.version.split(".").map(Number),
      }))
      .filter((item) => item.parts[0] >= 24)
      .toSorted((a, b) => compareVersions(a.parts, b.parts))[0]?.name ??
    names.find((name) => /ubuntu/i.test(name));
  if (!fallback) {
    die(`VM not found: ${requested}`);
  }
  warn(`requested VM ${requested} not found; using ${fallback}`);
  return fallback;
}

function listVms(): PrlctlVmListItem[] {
  return JSON.parse(
    run("prlctl", ["list", "--all", "--json"], { quiet: true }).stdout,
  ) as PrlctlVmListItem[];
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
