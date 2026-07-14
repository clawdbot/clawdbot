use crate::cli::openclaw_home;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

const INSTALL_EVENT: &str = "install-progress";
const ERROR_TAIL_LINES: usize = 24;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallChannel {
    Stable,
    Beta,
    Dev,
}

impl InstallChannel {
    fn version(self) -> &'static str {
        match self {
            Self::Stable => "latest",
            Self::Beta => "beta",
            Self::Dev => "main",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress<'a> {
    stream: &'a str,
    line: &'a str,
}

pub fn install(app: &AppHandle, channel: InstallChannel) -> Result<(), String> {
    let script = app
        .path()
        .resolve("install-cli.sh", BaseDirectory::Resource)
        .map_err(|error| format!("Bundled installer is unavailable: {error}"))?;
    let prefix = openclaw_home().map_err(|error| error.to_string())?;

    let mut command = Command::new("bash");
    command
        .arg(script)
        .args(["--json", "--no-onboard", "--prefix"])
        .arg(&prefix)
        .args(["--version", channel.version()]);
    if matches!(channel, InstallChannel::Dev) {
        command
            .args(["--install-method", "git", "--git-dir"])
            .arg(prefix.join("dev/openclaw"));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start bundled installer: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read installer output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read installer errors".to_string())?;
    let (sender, receiver) = mpsc::channel::<(&'static str, String)>();

    let stdout_thread = stream_lines("stdout", stdout, sender.clone());
    let stderr_thread = stream_lines("stderr", stderr, sender);
    let mut tail = VecDeque::with_capacity(ERROR_TAIL_LINES);
    for (stream, line) in receiver {
        let _ = app.emit_to(
            "main",
            INSTALL_EVENT,
            InstallProgress {
                stream,
                line: &line,
            },
        );
        if tail.len() == ERROR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for bundled installer: {error}"))?;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    if status.success() {
        return Ok(());
    }

    let detail = tail.into_iter().collect::<Vec<_>>().join("\n");
    if detail.is_empty() {
        Err(format!("Installer exited with {status}"))
    } else {
        Err(format!("Installer exited with {status}\n{detail}"))
    }
}

fn stream_lines<R>(
    stream: &'static str,
    reader: R,
    sender: mpsc::Sender<(&'static str, String)>,
) -> thread::JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if sender.send((stream, line)).is_err() {
                break;
            }
        }
    })
}
