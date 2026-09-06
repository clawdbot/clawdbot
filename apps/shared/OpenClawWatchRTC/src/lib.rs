#![deny(unsafe_op_in_unsafe_fn)]

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::time::Instant;
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc};

const CANDIDATE_BUDGET: usize = 100;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct OpenClawRTCAddress {
    address: [u8; 16],
    port: u16,
    family: u16,
}

impl OpenClawRTCAddress {
    fn socket(self) -> Result<SocketAddr, i32> {
        let ip = match self.family {
            4 => IpAddr::V4(Ipv4Addr::new(
                self.address[0],
                self.address[1],
                self.address[2],
                self.address[3],
            )),
            6 => IpAddr::V6(Ipv6Addr::from(self.address)),
            _ => return Err(-2),
        };
        if self.port == 0 || ip.is_unspecified() || ip.is_multicast() {
            return Err(-2);
        }
        Ok(SocketAddr::new(ip, self.port))
    }
}

impl From<SocketAddr> for OpenClawRTCAddress {
    fn from(value: SocketAddr) -> Self {
        let mut result = Self {
            port: value.port(),
            ..Self::default()
        };
        match value.ip() {
            IpAddr::V4(ip) => {
                result.family = 4;
                result.address[..4].copy_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                result.family = 6;
                result.address = ip.octets();
            }
        }
        result
    }
}

#[repr(C)]
#[derive(Default)]
pub struct OpenClawRTCOutput {
    kind: u32,
    bytes: *const u8,
    length: usize,
    source: OpenClawRTCAddress,
    destination: OpenClawRTCAddress,
    time: u64,
}

struct RemoteAddress {
    address: SocketAddr,
    candidates: Vec<Candidate>,
    resolved: Vec<SocketAddr>,
}

#[derive(Default)]
pub struct OpenClawRTC {
    rtc: Option<Rtc>,
    pending: Option<SdpPendingOffer>,
    mid: Option<Mid>,
    description: Vec<u8>,
    remote_addresses: Vec<RemoteAddress>,
    output_bytes: Vec<u8>,
}

// A panic must not cross the C ABI. A failed engine is discarded, never reused.
unsafe fn operate(
    pointer: *mut OpenClawRTC,
    operation: impl FnOnce(&mut OpenClawRTC) -> Result<(), i32>,
) -> i32 {
    let Some(state) = (unsafe { pointer.as_mut() }) else {
        return -1;
    };
    if state.rtc.is_none() {
        return -1;
    }
    match catch_unwind(AssertUnwindSafe(|| operation(state))) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(_) => {
            state.rtc = None;
            -1
        }
    }
}

unsafe fn input<'a>(bytes: *const u8, length: usize, maximum: usize) -> Result<&'a [u8], i32> {
    if bytes.is_null() || length == 0 || length > maximum {
        return Err(-2);
    }
    Ok(unsafe { std::slice::from_raw_parts(bytes, length) })
}

#[unsafe(no_mangle)]
pub extern "C" fn openclaw_rtc_create() -> *mut OpenClawRTC {
    catch_unwind(|| {
        // The pinned ICE default uses a non-cryptographic RNG. Supply independent
        // OS entropy: 64 bits for the ufrag and 192 bits for the password.
        let mut entropy = [0_u8; 32];
        if getrandom::fill(&mut entropy).is_err() {
            return ptr::null_mut();
        }
        let credentials = IceCreds {
            ufrag: entropy[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            pass: entropy[8..]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        };
        let rtc = Rtc::builder()
            .set_local_ice_credentials(credentials)
            .clear_codecs()
            .enable_opus(true)
            // Release each Opus frame despite loss; a nonzero window still drops
            // late frames instead of replaying them after newer speech.
            .set_reordering_size_audio(1)
            .build(Instant::now());
        Box::into_raw(Box::new(OpenClawRTC {
            rtc: Some(rtc),
            ..OpenClawRTC::default()
        }))
    })
    .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_free(pointer: *mut OpenClawRTC) {
    if !pointer.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(unsafe { Box::from_raw(pointer) })));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_add_candidate(
    pointer: *mut OpenClawRTC,
    address: OpenClawRTCAddress,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let candidate = Candidate::host(address.socket()?, Protocol::Udp).map_err(|_| -2)?;
            state.rtc.as_mut().ok_or(-1)?.add_local_candidate(candidate);
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_offer(pointer: *mut OpenClawRTC) -> i32 {
    unsafe {
        operate(pointer, |state| {
            if state.pending.is_some() || state.mid.is_some() {
                return Err(-1);
            }
            let mut changes = state.rtc.as_mut().ok_or(-1)?.sdp_api();
            state.mid =
                Some(changes.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None));
            let (offer, pending) = changes.apply().ok_or(-1)?;
            state.pending = Some(pending);
            state.description = offer.to_sdp_string().into_bytes();
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_remove_candidate(
    pointer: *mut OpenClawRTC,
    address: OpenClawRTCAddress,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let candidate = Candidate::host(address.socket()?, Protocol::Udp).map_err(|_| -2)?;
            // Only retire ICE state after our one SDP exchange; no later SDP offer
            // is generated from direct-API mutations.
            state
                .rtc
                .as_mut()
                .ok_or(-1)?
                .direct_api()
                .invalidate_candidate(&candidate);
            Ok(())
        })
    }
}

// Discovery metadata only: the unchanged SDP/ICE owner decides which candidates form pairs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_remote_address(
    pointer: *const OpenClawRTC,
    index: usize,
    address: *mut OpenClawRTCAddress,
) -> i32 {
    let (Some(state), Some(address)) = (unsafe { pointer.as_ref() }, unsafe { address.as_mut() })
    else {
        return -1;
    };
    if state.rtc.is_none() {
        return -1;
    }
    let Some(value) = state.remote_addresses.get(index) else {
        return 1;
    };
    *address = value.address.into();
    0
}

fn resolved_candidate(candidate: &Candidate, address: SocketAddr) -> Result<Candidate, i32> {
    // The pinned API has no address setter. Its canonical candidate attribute
    // preserves component, priority and ufrag; constructing a host instead
    // would bypass the ICE owner's admission rules. Never rewrite the full SDP.
    let text = candidate.to_sdp_string();
    let mut fields: Vec<_> = text.split_ascii_whitespace().collect();
    let ip = address.ip().to_string();
    fields[4] = &ip;
    Candidate::from_sdp_string(&fields.join(" ")).map_err(|_| -2)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_resolve_remote_address(
    pointer: *mut OpenClawRTC,
    index: usize,
    address: OpenClawRTCAddress,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let address = address.socket()?;
            let remote = state.remote_addresses.get(index).ok_or(-2)?;
            if !remote.address.is_ipv4()
                || !address.is_ipv6()
                || remote.address.port() != address.port()
            {
                return Err(-2);
            }
            if remote.resolved.contains(&address) {
                return Ok(());
            }
            let endpoints: HashSet<_> = state
                .remote_addresses
                .iter()
                .flat_map(|remote| {
                    std::iter::once(remote.address).chain(remote.resolved.iter().copied())
                })
                .collect();
            if endpoints.len() >= CANDIDATE_BUDGET && !endpoints.contains(&address) {
                return Err(-4);
            }
            let candidates = remote
                .candidates
                .iter()
                .map(|candidate| resolved_candidate(candidate, address))
                .collect::<Result<Vec<_>, _>>()?;
            let rtc = state.rtc.as_mut().ok_or(-1)?;
            for candidate in candidates {
                rtc.add_remote_candidate(candidate);
            }
            state.remote_addresses[index].resolved.push(address);
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_description(
    pointer: *const OpenClawRTC,
    length: *mut usize,
) -> *const u8 {
    let (Some(state), Some(length)) = (unsafe { pointer.as_ref() }, unsafe { length.as_mut() })
    else {
        return ptr::null();
    };
    *length = state.description.len();
    state.description.as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_answer(
    pointer: *mut OpenClawRTC,
    bytes: *const u8,
    length: usize,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let text = std::str::from_utf8(input(bytes, length, 65_536)?).map_err(|_| -2)?;
            let answer = SdpAnswer::from_sdp_string(text).map_err(|_| -2)?;
            // RFC 8838 Appendix B permits discovering our candidates through checks only
            // for an ICE-lite peer. This single-exchange client has no trickle channel.
            if !answer.session.ice_lite() {
                return Err(-3);
            }
            let credentials = answer
                .session
                .ice_creds()
                .or_else(|| {
                    answer
                        .media_lines
                        .iter()
                        .find_map(|media| media.ice_creds())
                })
                .ok_or(-2)?;
            let mut remote_addresses: Vec<RemoteAddress> = Vec::new();
            for candidate in answer.session.ice_candidates().chain(
                answer
                    .media_lines
                    .iter()
                    .flat_map(|media| media.ice_candidates()),
            ) {
                if candidate.proto() != Protocol::Udp
                    || candidate
                        .ufrag()
                        .is_some_and(|value| value != credentials.ufrag.as_str())
                {
                    continue;
                }
                let address = candidate.addr();
                OpenClawRTCAddress::from(address).socket()?;
                if let Some(remote) = remote_addresses
                    .iter_mut()
                    .find(|remote| remote.address == address)
                {
                    if !remote.candidates.contains(candidate) {
                        remote.candidates.push(candidate.clone());
                    }
                } else {
                    remote_addresses.push(RemoteAddress {
                        address,
                        candidates: vec![candidate.clone()],
                        resolved: Vec::new(),
                    });
                }
            }
            if remote_addresses.is_empty() {
                return Err(-3);
            }
            // Match the pinned ICE owner's default pair budget; never truncate the answer.
            if remote_addresses.len() > CANDIDATE_BUDGET {
                return Err(-4);
            }
            let pending = state.pending.take().ok_or(-1)?;
            state
                .rtc
                .as_mut()
                .ok_or(-1)?
                .sdp_api()
                .accept_answer(pending, answer)
                .map_err(|_| -1)?;
            state.remote_addresses = remote_addresses;
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_receive(
    pointer: *mut OpenClawRTC,
    source: OpenClawRTCAddress,
    destination: OpenClawRTCAddress,
    bytes: *const u8,
    length: usize,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let bytes = input(bytes, length, 2_000)?;
            let Ok(receive) = Receive::new(
                Protocol::Udp,
                source.socket()?,
                destination.socket()?,
                bytes,
            ) else {
                return Ok(()); // Unrelated/invalid UDP is not a session failure.
            };
            let rtc = state.rtc.as_mut().ok_or(-1)?;
            let input = Input::Receive(Instant::now(), receive);
            if rtc.accepts(&input) {
                rtc.handle_input(input).map_err(|_| -1)?;
            }
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_send_opus(
    pointer: *mut OpenClawRTC,
    bytes: *const u8,
    length: usize,
    timestamp: u64,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let bytes = input(bytes, length, 1_275)?;
            let rtc = state.rtc.as_mut().ok_or(-1)?;
            if !rtc.is_connected() {
                return Ok(());
            }
            let writer = rtc.writer(state.mid.ok_or(-1)?).ok_or(-1)?;
            let pt = writer
                .payload_params()
                .find(|p| p.spec().codec == Codec::Opus)
                .ok_or(-1)?
                .pt();
            writer
                .write(
                    pt,
                    Instant::now(),
                    MediaTime::new(timestamp, Frequency::FORTY_EIGHT_KHZ),
                    bytes,
                )
                .map_err(|_| -1)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_timeout(pointer: *mut OpenClawRTC) -> i32 {
    unsafe {
        operate(pointer, |state| {
            state
                .rtc
                .as_mut()
                .ok_or(-1)?
                .handle_input(Input::Timeout(Instant::now()))
                .map_err(|_| -1)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_poll(
    pointer: *mut OpenClawRTC,
    output: *mut OpenClawRTCOutput,
) -> i32 {
    let Some(output) = (unsafe { output.as_mut() }) else {
        return -2;
    };
    unsafe {
        operate(pointer, |state| {
            *output = OpenClawRTCOutput::default();
            loop {
                match state
                    .rtc
                    .as_mut()
                    .ok_or(-1)?
                    .poll_output()
                    .map_err(|_| -1)?
                {
                    Output::Timeout(deadline) => {
                        output.time = deadline
                            .saturating_duration_since(Instant::now())
                            .as_millis()
                            .min(60_000) as u64;
                        return Ok(());
                    }
                    Output::Transmit(packet) => {
                        output.kind = 1;
                        output.source = packet.source.into();
                        output.destination = packet.destination.into();
                        state.output_bytes.clear();
                        state.output_bytes.extend_from_slice(&packet.contents);
                    }
                    Output::Event(Event::Connected) => output.kind = 2,
                    Output::Event(Event::MediaData(media))
                        if media.params.spec().codec == Codec::Opus =>
                    {
                        output.kind = 3;
                        output.time = media.time.rebase(Frequency::FORTY_EIGHT_KHZ).numer();
                        state.output_bytes.clear();
                        state.output_bytes.extend_from_slice(&media.data);
                    }
                    Output::Event(Event::IceConnectionStateChange(
                        IceConnectionState::Disconnected,
                    )) => output.kind = 4,
                    Output::Event(Event::Closed) => output.kind = 5,
                    _ => continue,
                }
                if output.kind == 1 || output.kind == 3 {
                    output.bytes = state.output_bytes.as_ptr();
                    output.length = state.output_bytes.len();
                }
                return Ok(());
            }
        })
    }
}

#[cfg(test)]
mod tests;
