use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Url;

const GATEWAY_SERVICE_TYPE: &str = "_openclaw-gw._tcp.local.";

type GatewayMap = Arc<Mutex<BTreeMap<String, DiscoveredGateway>>>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredGateway {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub addresses: Vec<String>,
    pub tls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls_fingerprint_sha256: Option<String>,
    pub direct_reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailnet_dns: Option<String>,
}

impl DiscoveredGateway {
    fn from_service(service: &ResolvedService) -> Option<Self> {
        let host = validated_service_host(service.get_hostname())?;
        let mut addresses = service
            .get_addresses()
            .iter()
            // ScopedIp's Display preserves the interface required by IPv6 link-local routes.
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        addresses.sort();
        addresses.dedup();
        if addresses.is_empty() {
            return None;
        }

        let name = txt_value(service, "displayName")
            .map(|name| prettify_instance_name(&name))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| service_instance_name(service.get_fullname()));

        Some(Self {
            name,
            host,
            port: service.get_port(),
            addresses,
            tls: txt_bool(service, "gatewayTls"),
            tls_fingerprint_sha256: txt_value(service, "gatewayTlsSha256"),
            direct_reachable: txt_bool(service, "gatewayDirectReachable"),
            tailnet_dns: txt_value(service, "tailnetDns"),
        })
    }

    fn advertises_direct_transport(&self) -> bool {
        // The desktop has no SSH/relay transport, so match the native client's direct-selection gate.
        self.tls || self.direct_reachable || self.host.to_ascii_lowercase().ends_with(".ts.net")
    }

    fn has_safe_resolved_address(&self) -> bool {
        let addresses = self
            .addresses
            .iter()
            .filter_map(|address| resolved_ip_address(address))
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return false;
        }
        self.tls
            || (is_trusted_plaintext_host(&self.host)
                && addresses.iter().all(is_trusted_plaintext_address))
    }
}

struct DiscoveryRuntime {
    daemon: ServiceDaemon,
    receiver_alive: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct GatewayDiscovery {
    gateways: GatewayMap,
    runtime: Mutex<Option<DiscoveryRuntime>>,
    generation: Arc<AtomicU64>,
}

impl GatewayDiscovery {
    fn start(&self) -> Result<(), String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "Gateway discovery lock is unavailable.".to_string())?;
        if runtime
            .as_ref()
            .is_some_and(|runtime| runtime.receiver_alive.load(Ordering::Acquire))
        {
            return Ok(());
        }
        if let Some(stale) = runtime.take() {
            let _ = stale.daemon.shutdown();
        }
        clear_gateways(&self.gateways);

        let mdns = ServiceDaemon::new()
            .map_err(|error| format!("Could not start gateway discovery: {error}"))?;
        let events = match mdns.browse(GATEWAY_SERVICE_TYPE) {
            Ok(events) => events,
            Err(error) => {
                let _ = mdns.shutdown();
                return Err(format!("Could not browse for gateways: {error}"));
            }
        };
        let gateways = Arc::clone(&self.gateways);
        let receiver_alive = Arc::new(AtomicBool::new(true));
        let thread_receiver_alive = Arc::clone(&receiver_alive);
        let generation = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        let current_generation = Arc::clone(&self.generation);
        // A dead receiver makes the next snapshot rebuild discovery. The generation
        // prevents an old receiver from clearing a newer runtime's snapshot on exit.
        let thread = thread::Builder::new()
            .name("openclaw-gateway-discovery".to_string())
            .spawn(move || {
                while let Ok(event) = events.recv() {
                    if !apply_event(&gateways, event) {
                        break;
                    }
                }
                thread_receiver_alive.store(false, Ordering::Release);
                clear_gateways_if_current(&gateways, &current_generation, generation);
            });
        if let Err(error) = thread {
            let _ = mdns.shutdown();
            return Err(format!("Could not run gateway discovery: {error}"));
        }
        *runtime = Some(DiscoveryRuntime {
            daemon: mdns,
            receiver_alive,
        });
        Ok(())
    }

    fn snapshot(&self) -> Result<Vec<DiscoveredGateway>, String> {
        self.start()?;
        let mut gateways = self
            .gateways
            .lock()
            .map_err(|_| "Gateway discovery snapshot is unavailable.".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        gateways.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.host.cmp(&right.host))
                .then_with(|| left.port.cmp(&right.port))
        });
        Ok(gateways)
    }

    fn dashboard_url(&self, host: &str, port: u16, tls: bool) -> Result<Url, String> {
        let host = validated_service_host(host)
            .ok_or_else(|| "The discovered gateway returned an invalid host.".to_string())?;
        let gateways = self
            .gateways
            .lock()
            .map_err(|_| "Gateway discovery snapshot is unavailable.".to_string())?;
        let gateway = gateways
            .values()
            .find(|gateway| gateway.host == host && gateway.port == port && gateway.tls == tls)
            .ok_or_else(|| "The discovered gateway is no longer available.".to_string())?;
        if !gateway.advertises_direct_transport() {
            return Err(
                "The discovered gateway does not advertise a direct connection.".to_string(),
            );
        }
        if !gateway.has_safe_resolved_address() {
            return Err(
                "The discovered gateway does not have a safe resolved address.".to_string(),
            );
        }
        let mut url = Url::parse(if gateway.tls {
            "https://localhost/"
        } else {
            "http://localhost/"
        })
        .expect("static dashboard URL should parse");
        if gateway.tls {
            // TLS binds the validated SRV hostname through certificate validation and SNI.
            url.set_host(Some(&gateway.host))
                .map_err(|_| "The discovered gateway returned an invalid host.".to_string())?;
        } else {
            // Plaintext has no certificate binding, so navigate to the same private address
            // validated in this snapshot instead of letting WebKit resolve the hostname again.
            let address = gateway
                .addresses
                .iter()
                .filter_map(|address| resolved_ip_address(address))
                .find(is_trusted_plaintext_address)
                .ok_or_else(|| {
                    "The discovered gateway does not have a safe resolved address.".to_string()
                })?;
            url.set_ip_host(address)
                .map_err(|_| "The discovered gateway returned an invalid host.".to_string())?;
        }
        url.set_port(Some(gateway.port))
            .map_err(|_| "The discovered gateway returned an invalid port.".to_string())?;
        Ok(url)
    }
}

fn apply_event(gateways: &GatewayMap, event: ServiceEvent) -> bool {
    let Ok(mut gateways) = gateways.lock() else {
        return true;
    };
    match event {
        ServiceEvent::ServiceResolved(service) => {
            let fullname = service.get_fullname().to_string();
            match DiscoveredGateway::from_service(&service) {
                Some(gateway) => {
                    gateways.insert(fullname, gateway);
                }
                None => {
                    gateways.remove(&fullname);
                }
            }
        }
        // mdns-sd emits this for goodbye packets and expired cached records.
        ServiceEvent::ServiceRemoved(_, fullname) => {
            gateways.remove(&fullname);
        }
        ServiceEvent::SearchStopped(_) => return false,
        _ => {}
    }
    true
}

fn clear_gateways(gateways: &GatewayMap) {
    if let Ok(mut gateways) = gateways.lock() {
        gateways.clear();
    }
}

fn clear_gateways_if_current(
    gateways: &GatewayMap,
    current_generation: &AtomicU64,
    generation: u64,
) {
    let Ok(mut gateways) = gateways.lock() else {
        return;
    };
    // Replacement receivers insert under this lock, so a stale receiver cannot
    // pass the generation check and later erase a newer snapshot.
    if current_generation.load(Ordering::Acquire) == generation {
        gateways.clear();
    }
}

fn txt_value(service: &ResolvedService, key: &str) -> Option<String> {
    let value = service.get_property_val_str(key)?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn txt_bool(service: &ResolvedService, key: &str) -> bool {
    txt_value(service, key).is_some_and(|value| {
        value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
    })
}

fn validated_service_host(raw: &str) -> Option<String> {
    if raw.is_empty() || raw != raw.trim() {
        return None;
    }
    let host = raw.strip_suffix('.').unwrap_or(raw);
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let valid_labels = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    if !valid_labels {
        return None;
    }
    let mut url = Url::parse("https://localhost/").expect("static validation URL should parse");
    url.set_host(Some(host)).ok()?;
    if !url
        .host_str()
        .is_some_and(|normalized| normalized.eq_ignore_ascii_case(host))
    {
        return None;
    }
    Some(host.to_string())
}

fn resolved_ip_address(address: &str) -> Option<IpAddr> {
    address
        .split_once('%')
        .map_or(address, |(address, _scope)| address)
        .parse()
        .ok()
}

fn is_trusted_plaintext_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".ts.net")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| is_trusted_plaintext_address(&address))
}

fn is_trusted_plaintext_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, _, _] = address.octets();
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || (first == 100 && (64..=127).contains(&second))
        }
        IpAddr::V6(address) => {
            let first = address.segments()[0];
            address.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
    }
}

fn service_instance_name(fullname: &str) -> String {
    let instance = strip_ascii_suffix(fullname, GATEWAY_SERVICE_TYPE).trim_end_matches('.');
    let name = prettify_instance_name(&decode_bonjour_name(instance));
    if name.is_empty() {
        "OpenClaw Gateway".to_string()
    } else {
        name
    }
}

fn prettify_instance_name(name: &str) -> String {
    let normalized = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let without_conflict = strip_conflict_suffix(&normalized).trim();
    strip_ascii_suffix(without_conflict, " (OpenClaw)")
        .trim()
        .to_string()
}

fn strip_ascii_suffix<'a>(value: &'a str, suffix: &str) -> &'a str {
    let start = value.len().saturating_sub(suffix.len());
    if value
        .get(start..)
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(suffix))
    {
        &value[..start]
    } else {
        value
    }
}

fn strip_conflict_suffix(value: &str) -> &str {
    let Some(prefix) = value.strip_suffix(')') else {
        return value;
    };
    let Some(open) = prefix.rfind(" (") else {
        return value;
    };
    if prefix[open + 2..]
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        &prefix[..open]
    } else {
        value
    }
}

fn decode_bonjour_name(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let digits = &bytes[index + 1..index + 4];
            if digits.iter().all(u8::is_ascii_digit) {
                let number = u16::from(digits[0] - b'0') * 100
                    + u16::from(digits[1] - b'0') * 10
                    + u16::from(digits[2] - b'0');
                if let Ok(number) = u8::try_from(number) {
                    decoded.push(number);
                    index += 4;
                    continue;
                }
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[tauri::command]
pub fn discover_gateways(
    state: tauri::State<'_, GatewayDiscovery>,
) -> Result<Vec<DiscoveredGateway>, String> {
    state.snapshot()
}

#[tauri::command]
pub fn connect_discovered_gateway(
    app: tauri::AppHandle,
    desktop: tauri::State<'_, crate::DesktopState>,
    discovery: tauri::State<'_, GatewayDiscovery>,
    host: String,
    port: u16,
    tls: bool,
) -> Result<(), String> {
    let url = discovery.dashboard_url(&host, port, tls)?;
    desktop.navigate_remote(&app, url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdns_sd::ServiceInfo;

    fn service() -> ResolvedService {
        let properties = [
            ("transport", "gateway"),
            ("displayName", "Studio (OpenClaw)"),
            ("gatewayTls", "yes"),
            ("gatewayTlsSha256", "A1B2"),
            ("gatewayDirectReachable", "1"),
            ("tailnetDns", "studio.example.ts.net"),
        ];
        ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "studio (OpenClaw)",
            "studio.local.",
            "192.168.1.7,2001:db8::7",
            18789,
            &properties[..],
        )
        .expect("service should be valid")
        .as_resolved_service()
    }

    #[test]
    fn maps_gateway_service_contract() {
        let gateway = DiscoveredGateway::from_service(&service()).expect("valid gateway");
        assert_eq!(gateway.name, "Studio");
        assert_eq!(gateway.host, "studio.local");
        assert_eq!(gateway.port, 18789);
        assert_eq!(gateway.addresses, ["192.168.1.7", "2001:db8::7"]);
        assert!(gateway.tls);
        assert_eq!(gateway.tls_fingerprint_sha256.as_deref(), Some("A1B2"));
        assert!(gateway.direct_reachable);
        assert_eq!(
            gateway.tailnet_dns.as_deref(),
            Some("studio.example.ts.net")
        );
    }

    #[test]
    fn builds_dashboard_url_from_resolved_endpoint() {
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service())),
        );
        assert_eq!(
            discovery
                .dashboard_url("studio.local", 18789, true)
                .expect("dashboard URL")
                .as_str(),
            "https://studio.local:18789/"
        );
    }

    #[test]
    fn plaintext_dashboard_url_uses_validated_resolved_ipv4_address() {
        let service = ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "plaintext IPv4 (OpenClaw)",
            "plaintext-ipv4.local.",
            "192.168.1.9",
            18789,
            &[("gatewayDirectReachable", "1")][..],
        )
        .expect("service should be valid")
        .as_resolved_service();
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service)),
        );

        assert_eq!(
            discovery
                .dashboard_url("plaintext-ipv4.local", 18789, false)
                .expect("plaintext dashboard URL")
                .as_str(),
            "http://192.168.1.9:18789/"
        );
    }

    #[test]
    fn plaintext_dashboard_url_brackets_validated_resolved_ipv6_address() {
        let service = ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "plaintext IPv6 (OpenClaw)",
            "plaintext-ipv6.local.",
            "fd00::7",
            18789,
            &[("gatewayDirectReachable", "1")][..],
        )
        .expect("service should be valid")
        .as_resolved_service();
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service)),
        );

        assert_eq!(
            discovery
                .dashboard_url("plaintext-ipv6.local", 18789, false)
                .expect("plaintext IPv6 dashboard URL")
                .as_str(),
            "http://[fd00::7]:18789/"
        );
    }

    #[test]
    fn rejects_unsafe_advertised_hosts() {
        for host in [
            "attacker.example:443",
            "user@attacker.example",
            "attacker.example/path",
            "attacker.example\\path",
            "attacker.example?query",
            "attacker.example#fragment",
            " attacker.example",
            "attacker.example ",
            "attacker.example..",
            "-attacker.example",
            "attacker-.example",
            "attacker_name.local",
            "127.1",
            "0177.0.0.1",
            "0x7f000001",
            "2130706433",
            "fe80::1",
        ] {
            assert_eq!(validated_service_host(host), None, "host={host}");
        }
        assert_eq!(
            validated_service_host("studio.example.ts.net."),
            Some("studio.example.ts.net".to_string())
        );
    }

    #[test]
    fn rejects_public_plaintext_resolved_address() {
        let service = ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "public plaintext (OpenClaw)",
            "public-plaintext.local.",
            "198.51.100.7",
            18789,
            &[("gatewayDirectReachable", "1")][..],
        )
        .expect("service should be valid")
        .as_resolved_service();
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service)),
        );

        assert_eq!(
            discovery
                .dashboard_url("public-plaintext.local", 18789, false)
                .expect_err("public plaintext should not connect"),
            "The discovered gateway does not have a safe resolved address."
        );
    }

    #[test]
    fn rejects_public_plaintext_hostname_even_with_private_resolution() {
        let service = ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "public hostname (OpenClaw)",
            "dashboard.example.com.",
            "192.168.1.9",
            18789,
            &[("gatewayDirectReachable", "1")][..],
        )
        .expect("service should be valid")
        .as_resolved_service();
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service)),
        );

        assert_eq!(
            discovery
                .dashboard_url("dashboard.example.com", 18789, false)
                .expect_err("public plaintext hostname should not connect"),
            "The discovered gateway does not have a safe resolved address."
        );
    }

    #[test]
    fn keeps_validated_tls_hostname_with_ipv6_resolution() {
        let service = ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "ipv6 tls (OpenClaw)",
            "ipv6-tls.local.",
            "2001:db8::7",
            443,
            &[("gatewayTls", "1")][..],
        )
        .expect("service should be valid")
        .as_resolved_service();
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service)),
        );

        assert_eq!(
            discovery
                .dashboard_url("ipv6-tls.local", 443, true)
                .expect("IPv6 dashboard URL")
                .as_str(),
            "https://ipv6-tls.local/"
        );
    }

    #[test]
    fn preserves_ipv6_scope_while_validating_the_resolved_address() {
        let scoped = "fe80::7%en0";
        assert_eq!(
            resolved_ip_address(scoped),
            Some("fe80::7".parse().expect("IPv6 address"))
        );
        let gateway = DiscoveredGateway {
            name: "Scoped IPv6".to_string(),
            host: "scoped.local".to_string(),
            port: 18789,
            addresses: vec![scoped.to_string()],
            tls: false,
            tls_fingerprint_sha256: None,
            direct_reachable: true,
            tailnet_dns: None,
        };
        assert!(gateway.has_safe_resolved_address());
        assert_eq!(gateway.addresses, [scoped]);
    }

    #[test]
    fn rejects_gateway_without_direct_transport() {
        let service = ServiceInfo::new(
            GATEWAY_SERVICE_TYPE,
            "relay only (OpenClaw)",
            "relay-only.local.",
            "192.168.1.8",
            18789,
            &[("transport", "gateway")][..],
        )
        .expect("service should be valid")
        .as_resolved_service();
        let discovery = GatewayDiscovery::default();
        apply_event(
            &discovery.gateways,
            ServiceEvent::ServiceResolved(Box::new(service)),
        );
        assert_eq!(
            discovery
                .dashboard_url("relay-only.local", 18789, false)
                .expect_err("relay-only gateway should not connect"),
            "The discovered gateway does not advertise a direct connection."
        );
    }

    #[test]
    fn removal_event_expires_snapshot_entry() {
        let gateways = GatewayMap::default();
        let service = service();
        let fullname = service.get_fullname().to_string();
        apply_event(&gateways, ServiceEvent::ServiceResolved(Box::new(service)));
        assert_eq!(gateways.lock().expect("snapshot lock").len(), 1);

        apply_event(
            &gateways,
            ServiceEvent::ServiceRemoved(GATEWAY_SERVICE_TYPE.to_string(), fullname),
        );
        assert!(gateways.lock().expect("snapshot lock").is_empty());
    }

    #[test]
    fn rejected_refresh_expires_previous_snapshot_entry() {
        let gateways = GatewayMap::default();
        let service = service();
        apply_event(
            &gateways,
            ServiceEvent::ServiceResolved(Box::new(service.clone())),
        );
        assert_eq!(gateways.lock().expect("snapshot lock").len(), 1);

        let mut invalid_refresh = service;
        invalid_refresh.host = "attacker.example:443".to_string();
        apply_event(
            &gateways,
            ServiceEvent::ServiceResolved(Box::new(invalid_refresh)),
        );

        assert!(gateways.lock().expect("snapshot lock").is_empty());
    }

    #[test]
    fn stopped_search_marks_receiver_for_restart() {
        let gateways = GatewayMap::default();
        assert!(!apply_event(
            &gateways,
            ServiceEvent::SearchStopped(GATEWAY_SERVICE_TYPE.to_string())
        ));
    }

    #[test]
    fn stale_receiver_cannot_clear_a_newer_snapshot() {
        let gateways = GatewayMap::default();
        let service = service();
        apply_event(&gateways, ServiceEvent::ServiceResolved(Box::new(service)));
        let generation = AtomicU64::new(2);

        clear_gateways_if_current(&gateways, &generation, 1);

        assert_eq!(gateways.lock().expect("snapshot lock").len(), 1);
    }

    #[test]
    fn decodes_and_prettifies_fallback_name() {
        assert_eq!(
            service_instance_name("Peter\\032Studio\\032(OpenClaw)._openclaw-gw._tcp.local."),
            "Peter Studio"
        );
        assert_eq!(prettify_instance_name("Studio (OpenClaw) (2)"), "Studio");
    }
}
