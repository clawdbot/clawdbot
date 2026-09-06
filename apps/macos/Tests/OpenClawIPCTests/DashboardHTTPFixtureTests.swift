import Darwin
import Foundation
import Synchronization
import Testing

@MainActor
struct DashboardHTTPFixtureTests {
    @Test func `fixtures own distinct loopback endpoints serving inert HTML`() async throws {
        let first = try await DashboardHTTPFixture.start()
        defer { first.stop() }
        let second = try await DashboardHTTPFixture.start()
        defer { second.stop() }
        #expect(first.port != second.port)

        let session = Self.makeSession()
        defer { session.invalidateAndCancel() }

        for fixture in [first, second] {
            let url = fixture.url("/control/chat?session=fixture#token=fixture-token")
            #expect(url.host == "127.0.0.1")
            #expect(url.port == Int(fixture.port))
            #expect(url.path == "/control/chat")
            #expect(url.query == "session=fixture")
            #expect(url.fragment == "token=fixture-token")
            #expect(fixture.websocketURL("/control/").scheme == "ws")
            let (data, response) = try await session.data(from: url)
            let http = try #require(response as? HTTPURLResponse)
            #expect(http.statusCode == 200)
            #expect(String(decoding: data, as: UTF8.self) == DashboardHTTPFixture.html)
            #expect(http.value(forHTTPHeaderField: "Content-Security-Policy") == "default-src 'none'")
            #expect(http.value(forHTTPHeaderField: "Set-Cookie") == nil)
        }
    }

    @Test func `inert responses do not wait for the main actor`() async {
        // The child owns the actor stall so parallel suites keep their deadlines.
        await #expect(processExitsWith: .success) {
            try await DashboardHTTPFixtureTests.checkResponseWithBlockedMainActor()
        }
    }

    private static func checkResponseWithBlockedMainActor() async throws {
        let fixture = try await DashboardHTTPFixture.start()
        defer { fixture.stop() }
        let session = Self.makeSession()
        defer { session.invalidateAndCancel() }
        try Self.receiveWhileBlockingMainActor(fixture: fixture, session: session)
    }

    private static func receiveWhileBlockingMainActor(fixture: DashboardHTTPFixture, session: URLSession) throws {
        let completed = DispatchSemaphore(value: 0)
        let servedHTML = Mutex(false)
        let expectedBody = Data(DashboardHTTPFixture.html.utf8)
        let task = session.dataTask(with: fixture.url()) { data, response, error in
            servedHTML.withLock {
                $0 = error == nil && (response as? HTTPURLResponse)?.statusCode == 200 && data == expectedBody
            }
            completed.signal()
        }
        task.resume()
        // No actor suspension: accept/read/write must finish on the transport queue.
        try #require(completed.wait(timeout: .now() + 5) == .success)
        #expect(servedHTML.withLock { $0 })
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 5
        return URLSession(configuration: configuration)
    }

    @Test func `stopping a fixture closes unfinished clients and releases its listener`() async throws {
        let fixture = try await DashboardHTTPFixture.start()
        defer { fixture.stop() }
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        try #require(descriptor >= 0)
        defer { Darwin.close(descriptor) }
        try #require(fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0)
        var noSignal: Int32 = 1
        try #require(setsockopt(
            descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = fixture.port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        try #require(connected == 0 || errno == EINPROGRESS)
        var writable = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
        let connectDeadline = ContinuousClock.now + .seconds(2)
        while poll(&writable, 1, 0) == 0, ContinuousClock.now < connectDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(writable.revents & Int16(POLLOUT) != 0)
        let partialHeader = Array("GET /pending HTTP/1.1\r\n".utf8)
        let sent = partialHeader.withUnsafeBytes { Darwin.send(descriptor, $0.baseAddress, $0.count, 0) }
        try #require(sent == partialHeader.count)

        fixture.stop()
        fixture.stop()
        let deadline = ContinuousClock.now + .seconds(2)
        var byte: UInt8 = 0
        var closed = false
        while ContinuousClock.now < deadline {
            let received = Darwin.recv(descriptor, &byte, 1, 0)
            if received == 0 || (received == -1 && errno == ECONNRESET) {
                closed = true
                break
            }
            try #require(received == -1 && (errno == EAGAIN || errno == EWOULDBLOCK))
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(closed)

        let probe = socket(AF_INET, SOCK_STREAM, 0)
        try #require(probe >= 0)
        defer { Darwin.close(probe) }
        try #require(fcntl(probe, F_SETFL, O_NONBLOCK) == 0)
        let reconnected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        try #require(reconnected == -1)
        if errno == ECONNREFUSED { return }
        try #require(errno == EINPROGRESS)
        var probeEvents = pollfd(fd: probe, events: Int16(POLLOUT), revents: 0)
        while poll(&probeEvents, 1, 0) == 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(probeEvents.revents != 0)
        var socketError: Int32 = 0
        var errorLength = socklen_t(MemoryLayout<Int32>.size)
        try #require(getsockopt(probe, SOL_SOCKET, SO_ERROR, &socketError, &errorLength) == 0)
        #expect(socketError == ECONNREFUSED)
    }
}
