use serde::de::DeserializeOwned;
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

#[derive(Clone, Debug)]
pub struct OpenClawCli {
    executable: PathBuf,
    openclaw_home: PathBuf,
}

#[derive(Debug)]
pub enum CliError {
    Missing,
    Environment(String),
    Spawn(String),
    InvalidJson(String),
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => write!(formatter, "OpenClaw CLI not found"),
            Self::Environment(message) | Self::Spawn(message) | Self::InvalidJson(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for CliError {}

impl OpenClawCli {
    pub fn discover() -> Result<Self, CliError> {
        let home = openclaw_home()?;
        if let Some(override_path) = env::var_os("OPENCLAW_DESKTOP_CLI") {
            let cli = Self::new(PathBuf::from(override_path), home);
            cli.verify()?;
            return Ok(cli);
        }

        let managed = home.join("bin/openclaw");
        if managed.is_file() {
            let cli = Self::new(managed, home);
            cli.verify()?;
            return Ok(cli);
        }

        let cli = Self::new(PathBuf::from("openclaw"), home);
        match cli.verify() {
            Ok(()) => Ok(cli),
            Err(_) => Err(CliError::Missing),
        }
    }

    fn new(executable: PathBuf, openclaw_home: PathBuf) -> Self {
        Self {
            executable,
            openclaw_home,
        }
    }

    fn verify(&self) -> Result<(), CliError> {
        let output = self.output(["--version"])?;
        if output.status.success() {
            return Ok(());
        }
        Err(CliError::Spawn(format!(
            "OpenClaw CLI exited with {}",
            output.status
        )))
    }

    pub fn command<I, S>(&self, args: I) -> Result<Command, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = Command::new(&self.executable);
        command.args(args);
        command.env("PATH", self.command_path()?);
        command.stdin(Stdio::null());
        Ok(command)
    }

    pub fn output<I, S>(&self, args: I) -> Result<Output, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        self.command(args)?
            .output()
            .map_err(|error| CliError::Spawn(format!("Failed to run OpenClaw CLI: {error}")))
    }

    pub fn json<T, I, S>(&self, args: I) -> Result<(T, Output), CliError>
    where
        T: DeserializeOwned,
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let output = self.output(args)?;
        let value = serde_json::from_slice(&output.stdout).map_err(|error| {
            CliError::InvalidJson(format!("OpenClaw CLI returned invalid JSON: {error}"))
        })?;
        Ok((value, output))
    }

    fn command_path(&self) -> Result<OsString, CliError> {
        let mut paths = vec![
            self.openclaw_home.join("bin"),
            self.openclaw_home.join("tools/node/bin"),
        ];
        if let Some(current) = env::var_os("PATH") {
            paths.extend(env::split_paths(&current));
        }
        env::join_paths(paths)
            .map_err(|error| CliError::Environment(format!("Could not construct PATH: {error}")))
    }
}

pub fn openclaw_home() -> Result<PathBuf, CliError> {
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Environment("HOME is not set".to_string()))?;
    Ok(PathBuf::from(home).join(".openclaw"))
}
