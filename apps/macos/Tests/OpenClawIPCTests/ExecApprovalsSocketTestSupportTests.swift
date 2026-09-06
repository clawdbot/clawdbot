import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalsSocketTestSupportTests {
    @MainActor
    @Test func `socket roots are private unique temporary children with room for CUA endpoints`() throws {
        let fileManager = FileManager.default
        let base = fileManager.temporaryDirectory.resolvingSymlinksInPath()
        let first = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? fileManager.removeItem(at: first) }
        let second = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? fileManager.removeItem(at: second) }
        #expect(first != second)

        for root in [first, second] {
            #expect(root.path == root.resolvingSymlinksInPath().path)
            #expect(root.deletingLastPathComponent().path == base.path)
            let attributes = try fileManager.attributesOfItem(atPath: root.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)

            let directory = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
            defer { CuaDriverHostCoordinator.cleanupSocketDirectory(directory) }
            let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
            try #require(descriptor >= 0)
            defer { close(descriptor) }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let capacity = MemoryLayout.size(ofValue: address.sun_path)
            try #require(directory.socketPath.utf8.count < capacity)
            directory.socketPath.withCString { source in
                withUnsafeMutablePointer(to: &address.sun_path) {
                    $0.withMemoryRebound(to: CChar.self, capacity: capacity) {
                        _ = strcpy($0, source)
                    }
                }
            }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            #expect(result == 0)
        }
    }
}
