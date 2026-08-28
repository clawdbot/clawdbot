import Foundation
import Testing

struct TestProcessSupportPipeTests {
    @Test func `suppressed write end reports EPIPE instead of killing the harness`() throws {
        let pipe = Pipe()
        try TestProcessSupport.suppressSIGPIPE(pipe.fileHandleForWriting)
        try pipe.fileHandleForReading.close()

        // Without suppression this write would raise SIGPIPE and take down the
        // whole swiftpm-testing-helper process instead of throwing.
        #expect(throws: Error.self) {
            try pipe.fileHandleForWriting.write(contentsOf: Data("x".utf8))
        }
        try pipe.fileHandleForWriting.close()
    }
}
