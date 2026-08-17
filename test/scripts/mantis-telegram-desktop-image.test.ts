import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SCRIPT = "scripts/mantis/bake-telegram-desktop-image.sh";
const WORKFLOW = ".github/workflows/mantis-telegram-desktop-image.yml";

type WorkflowInput = {
  default?: boolean | string;
  type?: string;
};

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type Workflow = {
  jobs?: Record<
    string,
    {
      environment?: string;
      "runs-on"?: string;
      steps?: WorkflowStep[];
    }
  >;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, WorkflowInput>;
    };
  };
  permissions?: Record<string, string>;
};

function workflowStep(name: string): WorkflowStep {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.bake_telegram_desktop_image?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

describe("Mantis Telegram Desktop image bake", () => {
  it("keeps the manual workflow contract and coordinator secrets wired", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    const job = workflow.jobs?.bake_telegram_desktop_image;
    const bake = workflowStep("Bake and prove Telegram Desktop image");

    expect(inputs?.region).toMatchObject({ default: "eu-west-1", type: "string" });
    expect(inputs?.linux_type).toMatchObject({ default: "m7i.large", type: "string" });
    expect(inputs?.promote).toMatchObject({ default: true, type: "boolean" });
    expect(inputs?.crabbox_ref).toMatchObject({ default: "main", type: "string" });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.environment).toBe("qa-live-shared");
    expect(bake.env).toMatchObject({
      CRABBOX_COORDINATOR: "${{ secrets.CRABBOX_COORDINATOR }}",
      CRABBOX_COORDINATOR_ADMIN_TOKEN: "${{ secrets.CRABBOX_COORDINATOR_ADMIN_TOKEN }}",
      CRABBOX_ACCESS_CLIENT_ID: "${{ secrets.CRABBOX_ACCESS_CLIENT_ID }}",
      CRABBOX_ACCESS_CLIENT_SECRET: "${{ secrets.CRABBOX_ACCESS_CLIENT_SECRET }}",
    });
    expect(bake.run).toContain("bake-telegram-desktop-image.sh");
    expect(bake.run).toContain("--no-promote");
    expect(bake.run).toContain('--output "$output_dir/summary.json"');
    expect(bake.run).toContain('tee "$output_dir/bake.log"');
  });

  it("builds a variant-capable Crabbox CLI and uploads the bake evidence", () => {
    const install = workflowStep("Install Crabbox CLI");
    const upload = workflowStep("Upload Telegram Desktop image bake artifacts");

    expect(install.run).toContain("https://github.com/openclaw/crabbox.git");
    expect(install.run).toContain('go build -C "$install_dir/src"');
    expect(install.run).toContain("warmup --help");
    expect(install.run).toContain("media preview --help");
    expect(install.run).toContain('image promote --help > "$install_dir/image-promote-help.txt"');
    expect(install.run).toContain('grep -q -- "--variant-sdk"');
    expect(upload.uses).toContain("actions/upload-artifact@");
    expect(upload.with?.path).toBe(".artifacts/mantis/telegram-desktop-image");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  it("pins Telegram and proves explicit, promoted, and unchanged-default selection", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toContain('telegram_version="7.0.9"');
    expect(script).toContain(
      'telegram_url="https://github.com/telegramdesktop/tdesktop/releases/download/v7.0.9/tsetup.7.0.9.tar.xz"',
    );
    expect(script).toContain(
      'telegram_sha256="d3c05df0259ab116d11d8c1cdc1403019d2a3be303ad3b46d16a84e19df6615f"',
    );
    expect(script).toContain('--catalog-only --variant-sdk "$variant_sdk"');
    expect(script).toContain('args+=(--image-sdk "$image_selector")');
    expect(script).toContain('assert_selected_image "$log_dir/variant.log" "$ami_id" promoted');
    expect(script).toContain('if [[ "$default_image" == "$ami_id" ]]');
    expect(script).toContain("CRABBOX_COORDINATOR_ADMIN_TOKEN is required with --run");
  });

  it("parses as Bash and performs no Crabbox work without --run", () => {
    const syntax = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "telegram-image-dry-run-"));
    try {
      const crabbox = path.join(tempRoot, "crabbox");
      const marker = path.join(tempRoot, "called");
      writeFileSync(crabbox, `#!/usr/bin/env bash\nprintf called >${JSON.stringify(marker)}\n`);
      chmodSync(crabbox, 0o755);
      const dryRun = spawnSync("bash", [SCRIPT, "--crabbox-bin", crabbox], {
        encoding: "utf8",
      });

      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("dry plan only");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true });
    }
  });
});
