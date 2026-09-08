import Darwin
import Foundation
import Network
import OpenClawWatchRTC

enum WatchRealtimeMediaEvent: Sendable {
    case connected
    case audio(Data, timestamp: UInt64)
    case ended(WatchRealtimeMediaFailure)
}

struct WatchRealtimeMediaFailure: LocalizedError, Sendable {
    enum Kind: Sendable { case network, audio, sessionEnded, protocolError }
    let kind: Kind
    let message: String
    var errorDescription: String? {
        self.message
    }
}

enum WatchRealtimeMediaError: LocalizedError {
    case unavailable(String)
    var errorDescription: String? {
        switch self {
        case let .unavailable(message): message
        }
    }
}

/// The native engine, timer and Network callbacks have one serial queue owner.
final class WatchRealtimeTransport: @unchecked Sendable {
    private struct Route: Hashable, Sendable {
        let source: NWEndpoint
        let destination: NWEndpoint
    }

    private enum Binding {
        case discover(source: NWEndpoint, destination: NWEndpoint)
        case exact(Route)

        var requested: Route {
            switch self {
            case let .discover(source, destination): Route(source: source, destination: destination)
            case let .exact(route): route
            }
        }
    }

    private struct PendingCheck {
        let data: Data
        let deadline: DispatchTime
    }

    private struct Flow {
        let connection: NWConnection
        let binding: Binding
        var route: Route?
        var pending: PendingCheck?
    }

    struct RemoteAddress: Sendable {
        let index: Int
        let original: NWEndpoint
        let addresses: [NWEndpoint]
    }

    struct DiscoveryPlan: Sendable {
        let aliases: [(index: Int, address: NWEndpoint)]
        let pairs: [(source: NWEndpoint, destination: NWEndpoint)]
        let destinations: Set<NWEndpoint>
    }

    // is 0.11.0 retains at most 100 candidate pairs. Reject a larger discovery
    // plan instead of silently choosing the first interface or remote endpoint.
    private static let pairBudget = 100
    private let queue = DispatchQueue(label: "ai.openclaw.watch.realtime.media", qos: .userInitiated)
    private let onEvent: @Sendable (WatchRealtimeMediaEvent) -> Void
    private let cancellationLock = NSLock()
    private var cancelled = false
    private var started = false
    private var rtc: OpaquePointer?
    private var timer: DispatchSourceTimer?
    private var flows: [UUID: Flow] = [:]
    private var localCandidates: Set<NWEndpoint> = []
    private var remoteDestinations: Set<NWEndpoint> = []
    private var failedRoutes: Set<Route> = []
    private var activeRoute: Route?
    private var generation: UInt64 = 0
    private var pendingAnswer: CheckedContinuation<Void, Error>?

    init(onEvent: @escaping @Sendable (WatchRealtimeMediaEvent) -> Void) {
        self.onEvent = onEvent
    }

    deinit {
        self.timer?.cancel()
        self.flows.values.forEach { $0.connection.cancel() }
        if let rtc { openclaw_rtc_free(rtc) }
    }

    func makeOffer() async throws -> String {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.queue.async {
                    if self.started, !self.cancellationLock.withLock({ self.cancelled }) {
                        continuation
                            .resume(throwing: WatchRealtimeMediaError
                                .unavailable(String(localized: "Voice is already connecting.")))
                        return
                    }
                    do {
                        try continuation.resume(returning: self.begin())
                    } catch { continuation.resume(throwing: error)
                        self.fail(error)
                    }
                }
            }
        } onCancel: { self.cancel() }
    }

    func applyAnswer(_ answer: String) async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                self.queue.async {
                    do {
                        let data = Data(answer.utf8)
                        try data.withUnsafeBytes { bytes in
                            try self.mutate { openclaw_rtc_answer(
                                $0,
                                bytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                bytes.count) }
                        }
                        let remotes = try self.remoteAddresses()
                        self.pendingAnswer = continuation
                        let generation = self.generation
                        // getaddrinfo can block. Cancellation joins the RTC queue, never DNS.
                        DispatchQueue.global(qos: .utility).async { [weak self] in
                            var resolved: [RemoteAddress] = []
                            for (index, remote) in remotes.enumerated() {
                                guard self?.cancellationLock.withLock({ self?.cancelled == false }) == true
                                else { return }
                                resolved.append(RemoteAddress(
                                    index: index, original: remote, addresses: Self.resolveAddress(remote)))
                            }
                            self?.queue.async { [weak self, resolved] in
                                guard let self, self.generation == generation, self.pendingAnswer != nil else { return }
                                do {
                                    try self.discoverFlows(resolved)
                                    let completion = try self.cancellationLock.withLock {
                                        guard !self.cancelled else { throw CancellationError() }
                                        defer { self.pendingAnswer = nil }
                                        return self.pendingAnswer
                                    }
                                    completion?.resume()
                                } catch { self.fail(error) }
                            }
                        }
                    } catch { continuation.resume(throwing: error)
                        self.fail(error)
                    }
                }
            }
        } onCancel: { self.cancel() }
    }

    func sendOpus(_ data: Data, timestamp: UInt64) {
        self.queue.async {
            // Audio starts muted before signaling; pre-offer frames have no RTC owner.
            guard self.rtc != nil else { return }
            do {
                try data.withUnsafeBytes { bytes in
                    try self.mutate { openclaw_rtc_send_opus(
                        $0,
                        bytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        bytes.count,
                        timestamp) }
                }
            } catch { self.fail(error) }
        }
    }

    func cancel() {
        self.cancellationLock.withLock { self.cancelled = true }
        self.queue.async { self.tearDown() }
    }

    func stop() async {
        self.cancellationLock.withLock { self.cancelled = true }
        await withCheckedContinuation { continuation in
            self.queue.async {
                self.tearDown()
                continuation.resume()
            }
        }
    }

    private func begin() throws -> String {
        try self.cancellationLock.withLock {
            guard !self.cancelled else { throw CancellationError() }
            self.started = true
            self.generation &+= 1
            guard let rtc = openclaw_rtc_create() else {
                throw WatchRealtimeMediaError.unavailable(String(localized: "Unable to initialize secure voice."))
            }
            self.rtc = rtc
        }
        try self.drain()
        // No invented port is advertised. The answer must be ICE-lite, so our
        // authenticated checks let it discover the candidates gathered afterward.
        try self.mutate { openclaw_rtc_offer($0) }
        return try self.cancellationLock.withLock {
            guard !self.cancelled else { throw CancellationError() }
            var length = 0
            guard let rtc, let bytes = openclaw_rtc_description(rtc, &length),
                  let offer = String(data: Data(bytes: bytes, count: length), encoding: .utf8)
            else {
                throw WatchRealtimeMediaError.unavailable(String(localized: "Voice negotiation could not be created."))
            }
            return offer
        }
    }

    private func remoteAddresses() throws -> [NWEndpoint] {
        var remotes: [NWEndpoint] = []
        for index in 0...Self.pairBudget {
            var address = OpenClawRTCAddress()
            let result = try self.cancellationLock.withLock {
                guard !self.cancelled, let rtc else { throw CancellationError() }
                return openclaw_rtc_remote_address(rtc, index, &address)
            }
            if result == 1 { break }
            guard result == 0 else {
                throw WatchRealtimeMediaError
                    .unavailable(String(localized: "Voice has no supported remote network address."))
            }
            try remotes.append(Self.endpoint(address))
        }
        return remotes
    }

    static func discoveryPlan(remotes: [RemoteAddress], locals: [NWEndpoint]) throws -> DiscoveryPlan {
        var expanded = Set(remotes.map(\.original))
        var endpoints: [NWEndpoint] = []
        var aliases: [(index: Int, address: NWEndpoint)] = []
        for remote in remotes {
            var seen: Set<NWEndpoint> = []
            for address in remote.addresses where seen.insert(address).inserted {
                expanded.insert(address)
                if !endpoints.contains(address) { endpoints.append(address) }
                if !Self.sameFamily(remote.original, address) {
                    aliases.append((remote.index, address))
                }
            }
        }
        guard expanded.count <= Self.pairBudget else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice received too many network candidates."))
        }
        var pairs: [(source: NWEndpoint, destination: NWEndpoint)] = []
        var crossPairs = 0
        // Each seed can yield a different local port; include its cross-pairs
        // in the bound before starting any sockets, not just diagonal pairs.
        for source in locals {
            let destinations = endpoints.filter { Self.sameFamily(source, $0) }
            let engineRemotes = expanded.filter { Self.sameFamily(source, $0) }.count
            guard destinations.count <= (Self.pairBudget - crossPairs) / max(1, engineRemotes) else {
                throw WatchRealtimeMediaError
                    .unavailable(String(localized: "Voice cannot use this network candidate set."))
            }
            crossPairs += destinations.count * engineRemotes
            pairs.append(contentsOf: destinations.map { (source, $0) })
        }
        guard !pairs.isEmpty else {
            throw WatchRealtimeMediaFailure(
                kind: .network,
                message: String(localized: "Voice cannot use this network candidate set."))
        }
        return DiscoveryPlan(aliases: aliases, pairs: pairs, destinations: Set(endpoints))
    }

    private func discoverFlows(_ remotes: [RemoteAddress]) throws {
        // Resolve first, then gather current interfaces and bound the complete ICE/Network plan.
        let plan = try Self.discoveryPlan(remotes: remotes, locals: Self.localAddresses())
        self.remoteDestinations = plan.destinations
        for alias in plan.aliases {
            let address = try Self.nativeAddress(alias.address)
            try self.mutate { openclaw_rtc_resolve_remote_address($0, alias.index, address) }
        }
        for pair in plan.pairs {
            try self.openFlow(.discover(source: pair.source, destination: pair.destination))
        }
    }

    private func mutate(_ operation: (OpaquePointer) -> Int32) throws {
        try self.cancellationLock.withLock {
            guard !self.cancelled else { throw CancellationError() }
            guard let rtc else { throw CancellationError() }
            switch operation(rtc) {
            case 0: break
            case -3: throw WatchRealtimeMediaError
                .unavailable(String(localized: "This voice service must support ICE-lite with UDP candidates."))
            case -4: throw WatchRealtimeMediaError
                .unavailable(String(localized: "Voice received too many network candidates."))
            default: throw WatchRealtimeMediaError.unavailable(String(localized: "The secure voice connection failed."))
            }
        }
        try self.drain()
    }

    private func drain() throws {
        while true {
            var output = OpenClawRTCOutput()
            try self.cancellationLock.withLock {
                guard !self.cancelled, let rtc else { throw CancellationError() }
                guard openclaw_rtc_poll(rtc, &output) == 0 else {
                    throw WatchRealtimeMediaError.unavailable(String(localized: "The secure voice connection failed."))
                }
            }
            switch output.kind {
            case 0:
                self.scheduleTimeout(milliseconds: output.time)
                return
            case 1:
                guard let bytes = output.bytes else { continue }
                let route = try Route(
                    source: Self.endpoint(output.source),
                    destination: Self.endpoint(output.destination))
                try self.transmit(Data(bytes: bytes, count: output.length), route: route)
            case 2: self.onEvent(.connected)
            case 3:
                guard let bytes = output.bytes else { continue }
                self.onEvent(.audio(Data(bytes: bytes, count: output.length), timestamp: output.time))
            case 4: throw WatchRealtimeMediaFailure(
                    kind: .network,
                    message: String(localized: "Voice lost its network connection."))
            case 5: throw WatchRealtimeMediaFailure(kind: .sessionEnded, message: String(localized: "Voice ended."))
            default: break
            }
        }
    }

    private func scheduleTimeout(milliseconds: UInt64) {
        if let timer = self.timer {
            timer.schedule(deadline: .now() + .milliseconds(Int(max(1, milliseconds))))
            return
        }
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        let generation = self.generation
        timer.schedule(deadline: .now() + .milliseconds(Int(max(1, milliseconds))))
        timer.setEventHandler { [weak self] in
            guard let self, self.generation == generation else { return }
            do {
                try self.mutate { openclaw_rtc_timeout($0) }
            } catch { self.fail(error) }
        }
        self.timer = timer
        timer.resume()
    }

    @discardableResult
    private func openFlow(_ binding: Binding) throws -> UUID {
        guard self.flows.count < Self.pairBudget else {
            throw WatchRealtimeMediaError
                .unavailable(String(localized: "Voice exhausted its network candidate budget."))
        }
        let parameters = NWParameters.udp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = binding.requested.source
        let connection = NWConnection(to: binding.requested.destination, using: parameters)
        let id = UUID()
        self.flows[id] = Flow(connection: connection, binding: binding)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.queue.async {
                guard self.flows[id] != nil else { return }
                switch state {
                case .ready: self.flowReady(id)
                case let .failed(error), let .waiting(error): self.flowFailed(id, message: error.localizedDescription)
                default: break
                }
            }
        }
        connection.pathUpdateHandler = { [weak self] _ in
            guard let self else { return }
            self.queue.async {
                guard let flow = self.flows[id], let route = flow.route else { return }
                if !Self.matches(flow.connection, route: route) {
                    self.flowFailed(id, message: String(localized: "Voice changed its network address."))
                }
            }
        }
        try self.cancellationLock.withLock {
            guard !self.cancelled else { throw CancellationError() }
            connection.start(queue: self.queue)
        }
        return id
    }

    private func flowReady(_ id: UUID) {
        guard var flow = self.flows[id], flow.route == nil else { return }
        let route: Route
        do {
            route = try self.readyRoute(flow)
        } catch { self.flowFailed(id, message: error.localizedDescription)
            return
        }
        if let existing = self.flows.first(where: { $0.key != id && $0.value.route == route }) {
            self.flows.removeValue(forKey: id)?.connection.cancel()
            if let pending = flow.pending {
                do {
                    try self.send(pending, id: existing.key)
                } catch { self.fail(error) }
            }
            return
        }
        flow.route = route
        let pending = flow.pending
        flow.pending = nil
        self.flows[id] = flow
        self.failedRoutes.remove(route)
        do {
            // A receive owner and exact ready tuple exist before add_candidate can emit checks.
            try self.receive(id)
            if case .discover = flow.binding, self.localCandidates.insert(route.source).inserted {
                let native = try Self.nativeAddress(route.source)
                try self.mutate { openclaw_rtc_add_candidate($0, native) }
            }
            if let pending { try self.send(pending, id: id) }
        } catch { self.fail(error) }
    }

    private func readyRoute(_ flow: Flow) throws -> Route {
        guard let source = flow.connection.currentPath?.localEndpoint,
              let destination = flow.connection.currentPath?.remoteEndpoint
        else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice has no ready network address."))
        }
        _ = try Self.nativeAddress(source)
        _ = try Self.nativeAddress(destination)
        let requested = flow.binding.requested
        guard destination == requested.destination else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice changed its remote network address."))
        }
        switch flow.binding {
        case .discover:
            guard case let .hostPort(actualHost, actualPort) = source,
                  case let .hostPort(requestedHost, _) = requested.source,
                  actualHost == requestedHost, actualPort.rawValue != 0
            else {
                throw WatchRealtimeMediaError
                    .unavailable(String(localized: "Voice could not bind its local network address."))
            }
        case .exact:
            guard source == requested.source, self.localCandidates.contains(source) else {
                throw WatchRealtimeMediaError
                    .unavailable(String(localized: "Voice could not retain its network address."))
            }
        }
        return Route(source: source, destination: destination)
    }

    private func transmit(_ data: Data, route: Route) throws {
        // str0m 0.23.1 emits DTLS/media only from its nominated send_addr.
        // Only STUN checks may wait for a cross-pair to become ready.
        let isCheck = data.count >= 20 && data[0] & 0xC0 == 0 && data[4..<8].elementsEqual([0x21, 0x12, 0xA4, 0x42])
        // ICE retains signaled originals. They cannot reopen a route the system resolver omitted.
        guard self.remoteDestinations.contains(route.destination) else {
            if isCheck { return }
            throw WatchRealtimeMediaFailure(
                kind: .network,
                message: String(localized: "Voice has no ready media route."))
        }
        if !isCheck { self.activeRoute = route }
        guard !self.failedRoutes.contains(route) else {
            if !isCheck { throw WatchRealtimeMediaFailure(
                kind: .network,
                message: String(localized: "Voice lost its media route.")) }
            return
        }
        let existing = self.flows.first { $0.value.route == route } ?? self.flows.first { _, flow in
            if case let .exact(expected) = flow.binding { return expected == route }
            return false
        }
        let packet = PendingCheck(data: data, deadline: .now() + .milliseconds(1000))
        if let existing, existing.value.route != nil {
            try self.send(packet, id: existing.key)
        } else {
            guard isCheck else {
                throw WatchRealtimeMediaFailure(
                    kind: .network,
                    message: String(localized: "Voice has no ready media route."))
            }
            let id = try (existing?.key ?? self.openFlow(.exact(route)))
            // Expired/superseded UDP checks are intentional non-sends; the ICE
            // owner retains its own retransmission schedule and checklist.
            self.flows[id]?.pending = packet
        }
    }

    private func send(_ packet: PendingCheck, id: UUID) throws {
        let changed = try self.cancellationLock.withLock {
            guard !self.cancelled else { throw CancellationError() }
            guard let flow = self.flows[id], let route = flow.route else { return false }
            guard Self.matches(flow.connection, route: route) else { return true }
            let now = DispatchTime.now()
            guard packet.deadline > now else { return false }
            let remaining = max(1, (packet.deadline.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000)
            let context = NWConnection.ContentContext(identifier: "voice", expiration: UInt64(remaining))
            // Cancellation closes the same admission lock as native mutation and send.
            // The completion only enqueues work; it cannot reenter this lock inline.
            flow.connection.send(
                content: packet.data,
                contentContext: context,
                completion: .contentProcessed { [weak self] error in
                    guard let self, let error else { return }
                    self.queue.async { self.flowFailed(id, message: error.localizedDescription) }
                })
            return false
        }
        if changed { self.flowFailed(id, message: String(localized: "Voice changed its network address.")) }
    }

    private func receive(_ id: UUID) throws {
        try self.cancellationLock.withLock {
            guard !self.cancelled else { throw CancellationError() }
            guard let flow = self.flows[id], let route = flow.route else { return }
            flow.connection.receiveMessage { [weak self] data, _, _, error in
                guard let self else { return }
                self.queue.async {
                    guard let current = self.flows[id], current.route == route else { return }
                    guard error == nil, Self.matches(current.connection, route: route) else {
                        self.flowFailed(
                            id,
                            message: error?
                                .localizedDescription ?? String(localized: "Voice changed its network address."))
                        return
                    }
                    do {
                        if let data, !data.isEmpty, data.count <= 2000 {
                            let source = try Self.nativeAddress(route.destination)
                            let destination = try Self.nativeAddress(route.source)
                            try data.withUnsafeBytes { bytes in
                                try self.mutate { openclaw_rtc_receive(
                                    $0,
                                    source,
                                    destination,
                                    bytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                    bytes.count) }
                            }
                        }
                        try self.receive(id)
                    } catch { self.fail(error) }
                }
            }
        }
    }

    private func flowFailed(_ id: UUID, message: String) {
        guard let flow = self.flows.removeValue(forKey: id) else { return }
        flow.connection.cancel()
        if case let .exact(route) = flow.binding { self.failedRoutes.insert(route) }
        if let route = flow.route {
            self.failedRoutes.insert(route)
            if self.activeRoute == route { self.fail(WatchRealtimeMediaFailure(kind: .network, message: message))
                return
            }
            // Never mutate the engine recursively from its Transmit drain. A shared
            // local candidate retires only after its last exact ready owner disappears.
            let generation = self.generation
            self.queue.async {
                guard self.generation == generation,
                      !self.flows.values.contains(where: { $0.route?.source == route.source }),
                      self.localCandidates.remove(route.source) != nil else { return }
                do {
                    let native = try Self.nativeAddress(route.source)
                    try self.mutate { openclaw_rtc_remove_candidate($0, native) }
                } catch { self.fail(error) }
            }
        }
        if self.flows.isEmpty { self.fail(WatchRealtimeMediaFailure(kind: .network, message: message)) }
    }

    private func fail(_ error: Error) {
        let newlyClosed = self.cancellationLock.withLock {
            let wasOpen = !self.cancelled
            self.cancelled = true
            return wasOpen
        }
        let failure = error as? WatchRealtimeMediaFailure ??
            WatchRealtimeMediaFailure(kind: .protocolError, message: error.localizedDescription)
        self.tearDown(error: error)
        if newlyClosed { self.onEvent(.ended(failure)) }
    }

    private func tearDown(error: Error = CancellationError()) {
        let pendingAnswer = self.pendingAnswer
        self.pendingAnswer = nil
        self.generation &+= 1
        self.timer?.cancel()
        self.timer = nil
        self.flows.values.forEach { $0.connection.cancel() }
        self.flows.removeAll()
        self.localCandidates.removeAll()
        self.remoteDestinations.removeAll()
        self.failedRoutes.removeAll()
        self.activeRoute = nil
        if let rtc { openclaw_rtc_free(rtc) }
        self.rtc = nil
        pendingAnswer?.resume(throwing: error)
    }

    private static func matches(_ connection: NWConnection, route: Route) -> Bool {
        connection.currentPath?.localEndpoint == route.source && connection.currentPath?.remoteEndpoint == route
            .destination
    }

    private static func sameFamily(_ first: NWEndpoint, _ second: NWEndpoint) -> Bool {
        guard case let .hostPort(firstHost, _) = first, case let .hostPort(secondHost, _) = second else { return false }
        switch (firstHost, secondHost) {
        case (.ipv4, .ipv4), (.ipv6, .ipv6): return true
        default: return false
        }
    }

    private static func nativeAddress(_ endpoint: NWEndpoint) throws -> OpenClawRTCAddress {
        guard case let .hostPort(host, port) = endpoint else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice received an invalid network address."))
        }
        let bytes: Data
        var result = OpenClawRTCAddress()
        switch host {
        case let .ipv4(address): bytes = address.rawValue
            result.family = 4
        case let .ipv6(address): bytes = address.rawValue
            result.family = 6
        default: throw WatchRealtimeMediaError
            .unavailable(String(localized: "Voice requires a resolved network address."))
        }
        result.port = port.rawValue
        withUnsafeMutableBytes(of: &result.address) { $0.copyBytes(from: bytes) }
        return result
    }

    private static func endpoint(_ address: OpenClawRTCAddress) throws -> NWEndpoint {
        var address = address
        let data = withUnsafeBytes(of: &address.address) { Data($0.prefix(address.family == 4 ? 4 : 16)) }
        let host: NWEndpoint.Host
        if address.family == 4, let ip = IPv4Address(data) {
            host = .ipv4(ip)
        } else if address.family == 6, let ip = IPv6Address(data) {
            host = .ipv6(ip)
        } else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice received an invalid network address."))
        }
        guard let port = NWEndpoint.Port(rawValue: address.port) else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice received an invalid network port."))
        }
        return .hostPort(host: host, port: port)
    }

    private static func localAddresses() throws -> [NWEndpoint] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else {
            throw WatchRealtimeMediaError
                .unavailable(String(localized: "Voice cannot read the active network addresses."))
        }
        defer { if let first { freeifaddrs(first) } }
        var endpoints: [NWEndpoint] = []
        var next = first
        while let interface = next?.pointee {
            next = interface.ifa_next
            guard interface.ifa_flags & UInt32(IFF_UP | IFF_RUNNING) == UInt32(IFF_UP | IFF_RUNNING),
                  interface.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
                  let address = interface.ifa_addr else { continue }
            guard let host = Self.host(address) else { continue }
            let endpoint = NWEndpoint.hostPort(host: host, port: .any)
            if !endpoints.contains(endpoint) { endpoints.append(endpoint) }
        }
        return endpoints
    }

    private static func resolveAddress(_ endpoint: NWEndpoint) -> [NWEndpoint] {
        guard case let .hostPort(.ipv4(ip), port) = endpoint else { return [endpoint] }
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_DGRAM
        hints.ai_protocol = IPPROTO_UDP
        hints.ai_flags = AI_DEFAULT | AI_NUMERICSERV
        var first: UnsafeMutablePointer<addrinfo>?
        let literal = ip.rawValue.map(String.init).joined(separator: ".")
        guard getaddrinfo(literal, String(port.rawValue), &hints, &first) == 0 else { return [] }
        defer { if let first { freeaddrinfo(first) } }
        var endpoints: [NWEndpoint] = []
        var next = first
        while let resolved = next?.pointee {
            next = resolved.ai_next
            guard let address = resolved.ai_addr, let host = Self.host(address) else { continue }
            let result = NWEndpoint.hostPort(host: host, port: port)
            if !endpoints.contains(result) { endpoints.append(result) }
            // Keep the overflow sentinel: the whole expanded plan is rejected, never truncated.
            if endpoints.count > Self.pairBudget { break }
        }
        return endpoints
    }

    private static func host(_ address: UnsafePointer<sockaddr>) -> NWEndpoint.Host? {
        switch Int32(address.pointee.sa_family) {
        case AF_INET:
            var ip = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
            guard let parsed = IPv4Address(Data(bytes: &ip, count: 4)), !parsed.isLinkLocal else { return nil }
            return .ipv4(parsed)
        case AF_INET6:
            var ip = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
            guard let parsed = IPv6Address(Data(bytes: &ip, count: 16)), !parsed.isLinkLocal else { return nil }
            return .ipv6(parsed)
        default: return nil
        }
    }
}
