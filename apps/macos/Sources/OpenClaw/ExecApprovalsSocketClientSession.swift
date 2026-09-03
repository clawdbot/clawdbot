import Darwin
import Foundation

/// Owns one accepted descriptor and the task using it until request cleanup completes.
final class ExecApprovalsSocketClientSession: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private let monitor: DispatchSourceRead
    private var task: Task<Void, Never>?
    private var cancelled = false
    private var finished = false

    init(fd: Int32) throws {
        let queueFD = kqueue()
        guard queueFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var noSigPipe: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            close(queueFD)
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        var event = kevent(
            ident: UInt(fd),
            filter: Int16(EVFILT_WRITE),
            flags: UInt16(EV_ADD | EV_CLEAR),
            fflags: 0,
            data: 0,
            udata: nil)
        guard kevent(queueFD, &event, 1, nil, 0, nil) == 0 else {
            close(queueFD)
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        self.handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        self.monitor = DispatchSource.makeReadSource(fileDescriptor: queueFD, queue: .global(qos: .userInitiated))
        self.monitor.setEventHandler { [weak self] in
            var event = kevent()
            var timeout = timespec(tv_sec: 0, tv_nsec: 0)
            let count = kevent(queueFD, nil, 0, &event, 1, &timeout)
            // Request writers normally half-close. Only write-filter EOF means
            // the response reader has gone; read EOF must never cancel execution.
            if count > 0, event.flags & UInt16(EV_EOF | EV_ERROR) != 0 {
                self?.cancel()
            } else if count < 0, errno != EINTR {
                self?.cancel()
            }
        }
        self.monitor.setCancelHandler { close(queueFD) }
        self.monitor.resume()
    }

    func start(
        operation: @escaping @Sendable (FileHandle) async -> Void,
        onFinished: @escaping @Sendable () -> Void)
    {
        self.lock.withLock {
            self.task = Task.detached { [self] in
                if !self.lock.withLock({ self.cancelled }) {
                    await operation(self.handle)
                }
                self.finish()
                onFinished()
            }
            if self.cancelled { self.task?.cancel() }
        }
    }

    func cancel() {
        let task = self.lock.withLock { () -> Task<Void, Never>? in
            guard !self.finished, !self.cancelled else { return nil }
            self.cancelled = true
            // Wake blocked recv/send without releasing a descriptor still in use.
            // Only finish closes it, preventing cancellation from hitting a reused fd.
            _ = shutdown(self.handle.fileDescriptor, SHUT_RDWR)
            return self.task
        }
        task?.cancel()
    }

    func wait() async {
        let task = self.lock.withLock { self.task }
        await task?.value
    }

    private func finish() {
        self.lock.withLock {
            guard !self.finished else { return }
            self.finished = true
            self.task = nil
            self.monitor.cancel()
            try? self.handle.close()
        }
    }

    deinit {
        self.monitor.cancel()
    }
}
