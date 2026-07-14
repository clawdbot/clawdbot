use crate::cli::OpenClawCli;
use serde::{Deserialize, Serialize};
use std::thread;
use std::time::Duration;

const START_ATTEMPTS: usize = 20;
const START_POLL_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySnapshot {
    pub phase: &'static str,
    pub installed: bool,
    pub running: bool,
    pub reachable: bool,
    pub status: String,
    pub detail: Option<String>,
}

impl GatewaySnapshot {
    pub fn missing_cli() -> Self {
        Self {
            phase: "missingCli",
            installed: false,
            running: false,
            reachable: false,
            status: "CLI required".to_string(),
            detail: Some("Install the OpenClaw CLI to continue.".to_string()),
        }
    }

    pub fn reconnecting(detail: impl Into<String>) -> Self {
        Self {
            phase: "reconnecting",
            installed: true,
            running: false,
            reachable: false,
            status: "Reconnecting".to_string(),
            detail: Some(detail.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayAction {
    Start,
    Stop,
    Restart,
}

impl GatewayAction {
    fn command(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

pub struct ReadyGateway {
    pub snapshot: GatewaySnapshot,
    pub dashboard_url: String,
}

// Mirrors the JSON emitted by `src/cli/daemon-cli/status.print.ts`: service
// state establishes installation/runtime, while rpc.ok establishes reachability.
#[derive(Deserialize)]
struct DaemonStatus {
    service: ServiceStatus,
    rpc: Option<RpcStatus>,
}

#[derive(Deserialize)]
struct ServiceStatus {
    loaded: bool,
    command: Option<serde_json::Value>,
    runtime: Option<ServiceRuntime>,
}

#[derive(Deserialize)]
struct ServiceRuntime {
    // `GatewayServiceRuntime.status` is optional in the CLI JSON contract.
    status: Option<String>,
}

#[derive(Deserialize)]
struct RpcStatus {
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
struct CommandResponse {
    ok: bool,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardResponse {
    ok: bool,
    url: Option<String>,
    reason: Option<String>,
}

pub fn status(cli: &OpenClawCli) -> Result<GatewaySnapshot, String> {
    let (value, _) = cli
        .json::<DaemonStatus, _, _>(["gateway", "status", "--json"])
        .map_err(|error| error.to_string())?;
    let installed = value.service.command.is_some() || value.service.loaded;
    let runtime_status = value
        .service
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.status.as_deref())
        .unwrap_or("stopped");
    let running = runtime_status == "running";
    let reachable = value.rpc.as_ref().is_some_and(|rpc| rpc.ok);
    let phase = if reachable {
        "connected"
    } else if !installed {
        "notInstalled"
    } else if running {
        "reconnecting"
    } else {
        "stopped"
    };
    let detail = value
        .rpc
        .and_then(|rpc| rpc.error)
        .map(|error| {
            // The CLI reports "unauthorized" when a gateway this profile has no
            // credentials for already occupies the port (for example another
            // user's install); a raw auth error reads like an app bug.
            if error.to_ascii_lowercase().contains("unauthorized") {
                format!(
                    "{error}\nThe Gateway on the configured port rejected this profile's \
                     credentials. This may indicate another user's Gateway is using the \
                     port, or that this profile's stored token is stale. Run \
                     `openclaw gateway status` in a terminal to inspect it, then retry."
                )
            } else {
                error
            }
        })
        .or_else(|| (!running).then(|| format!("Gateway service is {runtime_status}.")));
    let status = if reachable {
        "Connected".to_string()
    } else if !installed {
        "Not installed".to_string()
    } else if running {
        "Unavailable".to_string()
    } else {
        "Stopped".to_string()
    };

    Ok(GatewaySnapshot {
        phase,
        installed,
        running,
        reachable,
        status,
        detail,
    })
}

pub fn ensure_ready(cli: &OpenClawCli) -> Result<ReadyGateway, String> {
    let mut snapshot = status(cli)?;
    if snapshot.reachable {
        return dashboard(cli, snapshot);
    }

    if !snapshot.installed {
        run_service_command(cli, "install")?;
        snapshot = status(cli)?;
    }
    if !snapshot.running {
        run_service_command(cli, "start")?;
    }

    snapshot = wait_until_reachable(cli)?;
    dashboard(cli, snapshot)
}

fn wait_until_reachable(cli: &OpenClawCli) -> Result<GatewaySnapshot, String> {
    let mut snapshot = status(cli)?;
    for attempt in 0..START_ATTEMPTS {
        if snapshot.reachable {
            return Ok(snapshot);
        }
        if attempt + 1 < START_ATTEMPTS {
            thread::sleep(START_POLL_INTERVAL);
            snapshot = status(cli)?;
        }
    }
    Err(snapshot
        .detail
        .unwrap_or_else(|| "Gateway did not become reachable.".to_string()))
}

pub fn act(cli: &OpenClawCli, action: GatewayAction) -> Result<GatewaySnapshot, String> {
    run_service_command(cli, action.command())?;
    if matches!(action, GatewayAction::Stop) {
        return status(cli);
    }
    wait_until_reachable(cli)
}

pub fn dashboard(cli: &OpenClawCli, snapshot: GatewaySnapshot) -> Result<ReadyGateway, String> {
    // CLIs released before `dashboard --json` reject the flag without JSON output;
    // surface an upgrade path instead of a raw parse error.
    let (response, output) =
        match cli.json::<DashboardResponse, _, _>(["dashboard", "--json", "--no-open"]) {
            Ok(result) => result,
            Err(crate::cli::CliError::InvalidJson(_)) => {
                return Err(
                    "The installed OpenClaw CLI does not support the desktop dashboard \
                 integration. Update OpenClaw (for example: npm install -g openclaw@latest), \
                 then retry."
                        .to_string(),
                );
            }
            Err(error) => return Err(error.to_string()),
        };
    if response.ok && output.status.success() {
        let dashboard_url = response
            .url
            .ok_or_else(|| "Dashboard response did not include a URL.".to_string())?;
        return Ok(ReadyGateway {
            snapshot,
            dashboard_url,
        });
    }
    Err(response
        .reason
        .unwrap_or_else(|| "Dashboard is not ready.".to_string()))
}

fn run_service_command(cli: &OpenClawCli, action: &str) -> Result<(), String> {
    let (response, output) = cli
        .json::<CommandResponse, _, _>(["gateway", action, "--json"])
        .map_err(|error| error.to_string())?;
    if response.ok && output.status.success() {
        return Ok(());
    }
    Err(response
        .error
        .or(response.message)
        .unwrap_or_else(|| format!("Gateway {action} failed.")))
}
