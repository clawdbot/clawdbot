import Darwin
import Foundation
import Testing

struct TestProcessSupportPipeTests {
    @Test func `suppression sets the pipe write end no-SIGPIPE flag`() throws {
        let pipe = Pipe()
        defer {
            try? pipe.fileHandleForReading.close()
            try? pipe.fileHandleForWriting.close()
        }
        let writeEnd = pipe.fileHandleForWriting

        // Concurrent preforked children can retain readers, so local closure cannot
        // prove process-global reader closure. This helper owns the writer's flag.
        #expect(fcntl(writeEnd.fileDescriptor, F_GETNOSIGPIPE) == 0)
        try TestProcessSupport.suppressSIGPIPE(writeEnd)
        #expect(fcntl(writeEnd.fileDescriptor, F_GETNOSIGPIPE) == 1)
    }
}
