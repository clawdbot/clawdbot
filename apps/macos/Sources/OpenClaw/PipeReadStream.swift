import Darwin
import Foundation

final class PipeReadStream: @unchecked Sendable {
    // Darwin FIONREAD is _IOR('f', 127, int); Swift cannot import that C macro.
    private static let bytesAvailableRequest: UInt = 0x4004_667F
    private let source: DispatchSourceRead
    private let queue: DispatchQueue
    private let maximumChunkBytes: Int
    private let onData: @Sendable (Data) -> Void
    private let completion: Task<Void, Never>

    init(
        handle: FileHandle,
        maximumChunkBytes: Int = 64 * 1024,
        queue: DispatchQueue = DispatchQueue(label: "ai.openclaw.pipe.read"),
        onData: @escaping @Sendable (Data) -> Void,
        onClose: @escaping @Sendable () -> Void = {}) throws
    {
        let descriptor = fcntl(handle.fileDescriptor, F_DUPFD_CLOEXEC, 0)
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
            let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            _ = Darwin.close(descriptor)
            throw error
        }
        let (closed, finished) = AsyncStream<Void>.makeStream()
        // A cancelled waiter must still join cleanup without cancelling other waiters.
        self.completion = Task { for await _ in closed {} }
        self.queue = queue
        self.maximumChunkBytes = maximumChunkBytes
        self.onData = onData
        self.source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        // Only dispatch cleanup closes the duplicate: cancellation may overlap an
        // active callback, and the original FileHandle can already be closed.
        self.source.setCancelHandler {
            _ = Darwin.close(descriptor)
            onClose()
            finished.finish()
        }
        self.source.setEventHandler { [weak self] in
            guard let self else { return }
            _ = self.read(maximumBytes: max(1, Int(self.source.data)))
        }
        self.source.resume()
    }

    deinit { self.close() }

    func close() {
        self.source.cancel()
    }

    func finish() async {
        self.queue.async {
            defer { self.close() }
            guard !self.source.isCancelled else { return }
            // Drain the exit-time snapshot, not EOF: inherited writers can stay
            // open or keep producing after the owned child has terminated.
            var available: Int32 = 0
            guard ioctl(Int32(self.source.handle), Self.bytesAvailableRequest, &available) == 0 else { return }
            while available > 0 {
                let count = self.read(maximumBytes: Int(available))
                guard count > 0 else { return }
                available -= Int32(count)
            }
        }
        await self.completion.value
    }

    private func read(maximumBytes: Int) -> Int {
        guard !self.source.isCancelled else { return 0 }
        let count = min(maximumBytes, self.maximumChunkBytes)
        var data = Data(count: count)
        var bytesRead: Int
        repeat {
            bytesRead = data.withUnsafeMutableBytes {
                Darwin.read(Int32(self.source.handle), $0.baseAddress, count)
            }
        } while bytesRead < 0 && errno == EINTR && !self.source.isCancelled
        guard bytesRead > 0 else {
            if bytesRead == 0 || errno != EAGAIN { self.close() }
            return 0
        }
        data.count = bytesRead
        self.onData(data)
        return bytesRead
    }
}
