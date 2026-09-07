import Testing
@testable import OpenClaw

#if canImport(Darwin)
import Darwin

struct ProcessSocketListenerInspectorTests {
    @Test func `finds listener owned by exact process`() throws {
        let listener = try Self.makeSocket(listen: true)
        defer { _ = Darwin.close(listener.fd) }
        let boundSocket = try Self.makeSocket(listen: false)
        defer { _ = Darwin.close(boundSocket.fd) }

        #expect(ProcessSocketListenerInspector.isListening(pid: getpid(), port: listener.port))
        #expect(!ProcessSocketListenerInspector.isListening(pid: getpid(), port: boundSocket.port))
    }

    @Test func `finds listener after initial descriptor buffer`() throws {
        var fillers: [Int32] = []
        defer {
            for fd in fillers {
                _ = Darwin.close(fd)
            }
        }

        for _ in 0..<96 {
            var pipeFDs: [Int32] = [-1, -1]
            try #require(Darwin.pipe(&pipeFDs) == 0)
            fillers.append(contentsOf: pipeFDs)
        }

        let listener = try Self.makeSocket(listen: true)
        defer { _ = Darwin.close(listener.fd) }

        #expect(ProcessSocketListenerInspector.isListening(pid: getpid(), port: listener.port))
    }

    private static func makeSocket(listen shouldListen: Bool) throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                Darwin.bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0, !shouldListen || Darwin.listen(fd, 1) == 0 else {
            _ = Darwin.close(fd)
            Issue.record("could not open loopback listener")
            throw ListenerError.openFailed
        }

        var boundAddress = sockaddr_in()
        var boundLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &boundAddress) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                getsockname(fd, socketAddress, &boundLength)
            }
        }
        guard nameResult == 0 else {
            _ = Darwin.close(fd)
            Issue.record("could not read loopback listener port")
            throw ListenerError.openFailed
        }
        return (fd, UInt16(bigEndian: boundAddress.sin_port))
    }

    private enum ListenerError: Error {
        case openFailed
    }
}
#endif
