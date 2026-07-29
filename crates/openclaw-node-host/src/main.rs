use openclaw_node_host::{run_host, HostConfig, HostCredentials};
use serde_json::json;
use std::{env, future::Future, path::PathBuf, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
    match Box::pin(run()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "{}",
                json!({
                    "level": "error",
                    "event": "host.failed",
                    "fields": {"message": error.to_string()},
                })
            );
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = config_path(env::args_os().skip(1))? else {
        return Ok(());
    };
    let config = HostConfig::load(&path)?;
    let credentials = HostCredentials::load(&config)?;
    let shutdown = register_shutdown_signal()?;
    Box::pin(run_host(config, credentials, shutdown)).await?;
    Ok(())
}

#[cfg(windows)]
fn register_shutdown_signal() -> Result<impl Future<Output = ()>, std::io::Error> {
    let mut signal = tokio::signal::windows::ctrl_c()?;
    Ok(async move {
        if signal.recv().await.is_none() {
            std::future::pending::<()>().await;
        }
    })
}

#[cfg(unix)]
fn register_shutdown_signal() -> Result<impl Future<Output = ()>, std::io::Error> {
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            Some(()) = interrupt.recv() => {}
            Some(()) = terminate.recv() => {}
            else => std::future::pending::<()>().await,
        }
    })
}

fn config_path(
    mut args: impl Iterator<Item = std::ffi::OsString>,
) -> Result<Option<PathBuf>, String> {
    let Some(argument) = args.next() else {
        return Err("usage: openclaw-node --config <path>".into());
    };
    if argument == "--help" || argument == "-h" {
        println!("Usage: openclaw-node --config <path>");
        return Ok(None);
    }
    if argument == "--version" || argument == "-V" {
        println!("openclaw-node {}", env!("CARGO_PKG_VERSION"));
        return Ok(None);
    }
    if argument != "--config" {
        return Err("usage: openclaw-node --config <path>".into());
    }
    let path = args
        .next()
        .ok_or_else(|| "--config requires a path".to_owned())?;
    if args.next().is_some() {
        return Err("unexpected arguments after the configuration path".into());
    }
    Ok(Some(path.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_requires_one_explicit_config_path() {
        assert_eq!(
            config_path(["--config", "node.json"].into_iter().map(Into::into)).unwrap(),
            Some(PathBuf::from("node.json"))
        );
        assert!(config_path(["--config"].into_iter().map(Into::into)).is_err());
        assert!(config_path(["node.json"].into_iter().map(Into::into)).is_err());
    }
}
