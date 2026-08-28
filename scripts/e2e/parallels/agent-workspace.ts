// Agent Workspace script supports OpenClaw repository automation.
export function posixAgentWorkspaceScript(purpose: string): string {
  return `set -eu
workspace="\${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
mkdir -p "$workspace/.openclaw"
cat > "$workspace/IDENTITY.md" <<'IDENTITY_EOF'
# Identity

- Name: OpenClaw
- Purpose: ${purpose}
IDENTITY_EOF
rm -f "$workspace/BOOTSTRAP.md"`;
}

export function windowsAgentWorkspaceScript(purpose: string): string {
  return `$workspace = $env:OPENCLAW_WORKSPACE_DIR
if (-not $workspace) { $workspace = Join-Path $env:USERPROFILE '.openclaw\\workspace' }
$stateDir = Join-Path $workspace '.openclaw'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
@'
# Identity

- Name: OpenClaw
- Purpose: ${purpose}
'@ | Set-Content -Path (Join-Path $workspace 'IDENTITY.md') -Encoding UTF8
Remove-Item (Join-Path $workspace 'BOOTSTRAP.md') -Force -ErrorAction SilentlyContinue`;
}
