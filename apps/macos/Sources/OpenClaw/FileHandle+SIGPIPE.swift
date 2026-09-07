import Darwin
import Foundation

extension FileHandle {
    /// Marks a pipe/socket write end so a vanished reader fails the write with a
    /// thrown EPIPE instead of raising SIGPIPE, which kills the whole process.
    /// Required on every write end whose reader is another process that can exit.
    @discardableResult
    func disableSIGPIPE() -> Bool {
        fcntl(self.fileDescriptor, F_SETNOSIGPIPE, 1) != -1
    }
}
