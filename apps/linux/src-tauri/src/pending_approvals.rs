use crate::cli::OpenClawCli;
use serde::Deserialize;
use std::collections::HashSet;
use std::process::Output;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ApprovalKind {
    Node,
    Device,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingApproval {
    kind: ApprovalKind,
    request_id: String,
    label: String,
}

impl PendingApproval {
    pub fn notification_body(&self) -> String {
        let kind = match self.kind {
            ApprovalKind::Node => "Node",
            ApprovalKind::Device => "Device",
        };
        format!(
            "{kind} pairing request from {} — open the dashboard to approve",
            self.label
        )
    }
}

#[derive(Default)]
pub struct PendingApprovalState {
    visible: HashSet<String>,
}

pub struct PendingApprovalDiff {
    pub new: Vec<PendingApproval>,
    pub count: usize,
}

impl PendingApprovalState {
    pub fn update(&mut self, current: &[PendingApproval]) -> PendingApprovalDiff {
        let (new, visible) = diff_pending(&self.visible, current);
        let count = visible.len();
        self.visible = visible;
        PendingApprovalDiff { new, count }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodePendingRequest {
    request_id: String,
    node_id: String,
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePendingRequest {
    request_id: String,
    device_id: String,
    display_name: Option<String>,
    client_id: Option<String>,
}

#[derive(Deserialize)]
struct DevicePairingList {
    #[serde(default)]
    pending: Vec<DevicePendingRequest>,
}

pub fn fetch(cli: &OpenClawCli) -> Result<Vec<PendingApproval>, String> {
    let (nodes, node_output) = cli
        .json::<Vec<NodePendingRequest>, _, _>(["nodes", "pending", "--json"])
        .map_err(|error| error.to_string())?;
    require_success("nodes pending", &node_output)?;

    let (devices, device_output) = cli
        .json::<DevicePairingList, _, _>(["devices", "list", "--json"])
        .map_err(|error| error.to_string())?;
    require_success("devices list", &device_output)?;

    let mut pending = Vec::with_capacity(nodes.len() + devices.pending.len());
    pending.extend(nodes.into_iter().map(|request| PendingApproval {
        kind: ApprovalKind::Node,
        request_id: request.request_id,
        label: preferred_label([request.display_name.as_deref(), Some(&request.node_id)]),
    }));
    pending.extend(devices.pending.into_iter().map(|request| PendingApproval {
        kind: ApprovalKind::Device,
        request_id: request.request_id,
        label: preferred_label([
            request.display_name.as_deref(),
            request.client_id.as_deref(),
            Some(&request.device_id),
        ]),
    }));
    Ok(pending)
}

fn require_success(command: &str, output: &Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("openclaw {command} exited with {}", output.status))
    }
}

fn preferred_label<'a>(candidates: impl IntoIterator<Item = Option<&'a str>>) -> String {
    candidates
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

// Only successful snapshots replace `visible`; failed polls must leave dedupe state intact.
fn diff_pending(
    previous: &HashSet<String>,
    current: &[PendingApproval],
) -> (Vec<PendingApproval>, HashSet<String>) {
    let mut visible = HashSet::with_capacity(current.len());
    let mut new = Vec::new();
    for request in current {
        if visible.insert(request.request_id.clone()) && !previous.contains(&request.request_id) {
            new.push(request.clone());
        }
    }
    (new, visible)
}

#[cfg(test)]
mod tests {
    use super::{diff_pending, ApprovalKind, PendingApproval, PendingApprovalState};
    use std::collections::HashSet;

    fn request(kind: ApprovalKind, id: &str, label: &str) -> PendingApproval {
        PendingApproval {
            kind,
            request_id: id.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn diff_reports_new_ids_once_and_deduplicates_a_snapshot() {
        let current = vec![
            request(ApprovalKind::Node, "node-1", "Kitchen Mac"),
            request(ApprovalKind::Node, "node-1", "Kitchen Mac"),
            request(ApprovalKind::Device, "device-1", "Browser"),
        ];

        let (new, visible) = diff_pending(&HashSet::new(), &current);

        assert_eq!(new, vec![current[0].clone(), current[2].clone()]);
        assert_eq!(visible.len(), 2);
    }

    #[test]
    fn state_deduplicates_retained_ids_and_forgets_removed_ids() {
        let node = request(ApprovalKind::Node, "request-1", "Kitchen Mac");
        let device = request(ApprovalKind::Device, "request-2", "Browser");
        let mut state = PendingApprovalState::default();

        let first = state.update(&[node.clone(), device.clone()]);
        assert_eq!(first.new, vec![node.clone(), device.clone()]);
        assert_eq!(first.count, 2);

        let retained = state.update(std::slice::from_ref(&device));
        assert!(retained.new.is_empty());
        assert_eq!(retained.count, 1);

        let returned = state.update(&[node.clone(), device]);
        assert_eq!(returned.new, vec![node]);
        assert_eq!(returned.count, 2);
    }

    #[test]
    fn same_id_is_deduplicated_across_request_kinds() {
        let node = request(ApprovalKind::Node, "same-id", "Node");
        let device = request(ApprovalKind::Device, "same-id", "Browser");

        let (new, visible) = diff_pending(&HashSet::new(), &[node.clone(), device]);

        assert_eq!(new, vec![node]);
        assert_eq!(visible.len(), 1);
    }

    #[test]
    fn notification_copy_names_request_kind_and_source() {
        assert_eq!(
            request(ApprovalKind::Node, "request-1", "Kitchen Mac").notification_body(),
            "Node pairing request from Kitchen Mac — open the dashboard to approve"
        );
        assert_eq!(
            request(ApprovalKind::Device, "request-2", "Browser").notification_body(),
            "Device pairing request from Browser — open the dashboard to approve"
        );
    }
}
