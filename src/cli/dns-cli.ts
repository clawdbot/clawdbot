import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { getWideAreaZonePath, WIDE_AREA_DISCOVERY_DOMAIN } from "../infra/widearea-dns.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

type RunOpts = { allowFailure?: boolean; inherit?: boolean };

function run(cmd: string, args: string[], opts?: RunOpts): string {
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: opts?.inherit ? "inherit" : "pipe",
  });
  if (res.error) throw res.error;
  if (!opts?.allowFailure && res.status !== 0) {
    const errText =
      typeof res.stderr === "string" && res.stderr.trim()
        ? res.stderr.trim()
        : `exit ${res.status ?? "unknown"}`;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${errText}`);
  }
  return typeof res.stdout === "string" ? res.stdout : "";
}

function writeFileSudoIfNeeded(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EACCES" && code !== "EPERM") {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  const res = spawnSync("sudo", ["tee", filePath], {
    input: content,
    encoding: "utf-8",
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`sudo tee ${filePath} failed: exit ${res.status ?? "unknown"}`);
  }
}

function mkdirSudoIfNeeded(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EACCES" && code !== "EPERM") {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  run("sudo", ["mkdir", "-p", dirPath], { inherit: true });
}

function zoneFileNeedsBootstrap(zonePath: string): boolean {
  if (!fs.existsSync(zonePath)) return true;
  try {
    const content = fs.readFileSync(zonePath, "utf-8");
    return !/\bSOA\b/.test(content) || !/\bNS\b/.test(content);
  } catch {
    return true;
  }
}

function detectBrewPrefix(): string {
  const out = run("brew", ["--prefix"]);
  const prefix = out.trim();
  if (!prefix) throw new Error("failed to resolve Homebrew prefix");
  return prefix;
}

function ensureImportLine(corefilePath: string, importGlob: string): boolean {
  const existing = fs.readFileSync(corefilePath, "utf-8");
  if (existing.includes(importGlob)) return false;
  const next = `${existing.replace(/\s*$/, "")}\n\nimport ${importGlob}\n`;
  writeFileSudoIfNeeded(corefilePath, next);
  return true;
}

export function registerDnsCli(program: Command) {
  const dns = program
    .command("dns")
    .description("DNS helpers for wide-area discovery (Tailscale + CoreDNS)")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/dns", "docs.clawd.bot/cli/dns")}\n`,
    );

  dns
    .command("setup")
    .description("Set up CoreDNS to serve clawdbot.internal for unicast DNS-SD (Wide-Area Bonjour)")
    .option(
      "--apply",
      "Install/update CoreDNS config and (re)start the service (requires sudo)",
      false,
    )
    .action(async (opts) => {
      const cfg = loadConfig();
      const tailnetIPv4 = pickPrimaryTailnetIPv4();
      const tailnetIPv6 = pickPrimaryTailnetIPv6();
      const zonePath = getWideAreaZonePath();

      console.log(`Domain: ${WIDE_AREA_DISCOVERY_DOMAIN}`);
      console.log(`Zone file (gateway-owned): ${zonePath}`);
      console.log(
        `Detected tailnet IP: ${tailnetIPv4 ?? "—"}${tailnetIPv6 ? ` (v6 ${tailnetIPv6})` : ""}`,
      );
      console.log("");
      console.log("Recommended ~/.clawdbot/clawdbot.json:");
      console.log(
        JSON.stringify(
          {
            bridge: { bind: "tailnet" },
            discovery: { wideArea: { enabled: true } },
          },
          null,
          2,
        ),
      );
      console.log("");
      console.log("Tailscale admin (DNS → Nameservers):");
      console.log(`- Add nameserver: ${tailnetIPv4 ?? "<this machine's tailnet IPv4>"}`);
      console.log(`- Restrict to domain (Split DNS): clawdbot.internal`);

      if (!opts.apply) {
        console.log("");
        console.log("Run with --apply to install CoreDNS and configure it.");
        return;
      }

      if (process.platform !== "darwin") {
        throw new Error("dns setup is currently supported on macOS only");
      }
      if (!tailnetIPv4 && !tailnetIPv6) {
        throw new Error("no tailnet IP detected; ensure Tailscale is running on this machine");
      }

      const prefix = detectBrewPrefix();
      const etcDir = path.join(prefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const confDir = path.join(etcDir, "conf.d");
      const importGlob = path.join(confDir, "*.server");
      const serverPath = path.join(confDir, "clawdbot.internal.server");

      run("brew", ["list", "coredns"], { allowFailure: true });
      run("brew", ["install", "coredns"], {
        inherit: true,
        allowFailure: true,
      });

      mkdirSudoIfNeeded(confDir);

      if (!fs.existsSync(corefilePath)) {
        writeFileSudoIfNeeded(corefilePath, `import ${importGlob}\n`);
      } else {
        ensureImportLine(corefilePath, importGlob);
      }

      const bindArgs = [tailnetIPv4, tailnetIPv6].filter((v): v is string => Boolean(v?.trim()));

      const server = [
        `${WIDE_AREA_DISCOVERY_DOMAIN.replace(/\.$/, "")}:53 {`,
        `  bind ${bindArgs.join(" ")}`,
        `  file ${zonePath} {`,
        `    reload 10s`,
        `  }`,
        `  errors`,
        `  log`,
        `}`,
        ``,
      ].join("\n");
      writeFileSudoIfNeeded(serverPath, server);

      // Ensure the gateway can write its zone file path.
      await fs.promises.mkdir(path.dirname(zonePath), { recursive: true });
      if (zoneFileNeedsBootstrap(zonePath)) {
        const y = new Date().getUTCFullYear();
        const m = String(new Date().getUTCMonth() + 1).padStart(2, "0");
        const d = String(new Date().getUTCDate()).padStart(2, "0");
        const serial = `${y}${m}${d}01`;

        const zoneLines = [
          `; created by clawdbot dns setup (will be overwritten by the gateway when wide-area discovery is enabled)`,
          `$ORIGIN ${WIDE_AREA_DISCOVERY_DOMAIN}`,
          `$TTL 60`,
          `@ IN SOA ns1 hostmaster ${serial} 7200 3600 1209600 60`,
          `@ IN NS ns1`,
          tailnetIPv4 ? `ns1 IN A ${tailnetIPv4}` : null,
          tailnetIPv6 ? `ns1 IN AAAA ${tailnetIPv6}` : null,
          ``,
        ].filter((line): line is string => Boolean(line));

        fs.writeFileSync(zonePath, zoneLines.join("\n"), "utf-8");
      }

      console.log("");
      console.log("Starting CoreDNS (sudo)…");
      run("sudo", ["brew", "services", "restart", "coredns"], {
        inherit: true,
      });

      if (cfg.discovery?.wideArea?.enabled !== true) {
        console.log("");
        console.log(
          "Note: enable discovery.wideArea.enabled in ~/.clawdbot/clawdbot.json on the gateway and restart the gateway so it writes the DNS-SD zone.",
        );
      }
    });
}
