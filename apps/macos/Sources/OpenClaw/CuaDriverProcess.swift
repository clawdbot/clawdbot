import Darwin
import Foundation

@MainActor
protocol CuaDriverProcessControlling: AnyObject {
    var isRunning: Bool { get }
    /// Spawned daemon pid. OpenClaw records this itself because `serve` ignores
    /// `--pid-file` and writes only the machine-global default path.
    var processIdentifier: pid_t { get }
    func closeLiveness()
    func terminate()
    func forceKill()
}

@MainActor
final class FoundationCuaDriverProcess: CuaDriverProcessControlling {
    let process: Process
    private let livenessPipe: Pipe

    init(process: Process, livenessPipe: Pipe) {
        self.process = process
        self.livenessPipe = livenessPipe
    }

    deinit {
        try? self.livenessPipe.fileHandleForWriting.close()
    }

    var isRunning: Bool {
        self.process.isRunning
    }

    var processIdentifier: pid_t {
        self.process.processIdentifier
    }

    func closeLiveness() {
        try? self.livenessPipe.fileHandleForWriting.close()
    }

    func terminate() {
        guard self.process.isRunning else { return }
        self.process.terminate()
    }

    func forceKill() {
        guard self.process.isRunning else { return }
        _ = Darwin.kill(self.process.processIdentifier, SIGKILL)
    }
}

enum CuaDriverStderrEvent: Equatable, Sendable {
    case notice(String)
    case error(String)
}

final class CuaDriverStderrRelay: @unchecked Sendable {
    static let managedModeNotice =
        """
        CUA embedded driver running in managed unrestricted mode; \
        OpenClaw command arming and pairing are the authorization boundary.
        """

    private static let dangerBannerPrefix = "DANGER: Cua Driver is running in unrestricted mode"
    private static let maximumBufferedBytes = 32 * 1024
    private static let readChunkBytes = 4 * 1024

    let pipe = Pipe()

    private let lock = NSLock()
    private let emit: @Sendable (CuaDriverStderrEvent) -> Void
    private var buffer = Data()
    private var reader: PipeReadStream?
    private var stopped = false
    private var emittedManagedModeNotice = false

    init(emit: @escaping @Sendable (CuaDriverStderrEvent) -> Void) {
        self.emit = emit
    }

    func startReading() throws {
        try self.lock.withLock {
            guard self.reader == nil, !self.stopped else { return }
            self.reader = try PipeReadStream(
                handle: self.pipe.fileHandleForReading,
                maximumChunkBytes: Self.readChunkBytes,
                onData: { [weak self] in self?.consume($0) },
                onClose: { [weak self] in self?.stop() })
        }
    }

    func reportManagedMode() {
        let shouldEmit = self.lock.withLock {
            guard !self.stopped, !self.emittedManagedModeNotice else { return false }
            self.emittedManagedModeNotice = true
            return true
        }
        if shouldEmit {
            self.emit(.notice(Self.managedModeNotice))
        }
    }

    func finishReading() async {
        let reader = self.lock.withLock { self.reader }
        await reader?.finish()
    }

    func stop() {
        let tail = self.lock.withLock { () -> Data? in
            guard !self.stopped else { return nil }
            self.stopped = true
            defer { self.buffer.removeAll(keepingCapacity: false) }
            return self.buffer.isEmpty ? nil : self.buffer
        }
        self.reader?.close()
        try? self.pipe.fileHandleForReading.close()
        try? self.pipe.fileHandleForWriting.close()
        if let tail {
            self.forward(tail)
        }
    }

    private func consume(_ data: Data) {
        let lines = self.lock.withLock { () -> [Data] in
            guard !self.stopped else { return [] }
            self.buffer.append(data)
            if self.buffer.count > Self.maximumBufferedBytes {
                self.buffer = Data(self.buffer.suffix(Self.maximumBufferedBytes))
            }
            var lines: [Data] = []
            while let newline = self.buffer.firstIndex(of: 0x0A) {
                lines.append(Data(self.buffer[..<newline]))
                self.buffer.removeSubrange(...newline)
            }
            return lines
        }
        lines.forEach(self.forward)
    }

    private func forward(_ data: Data) {
        // The byte cap can split UTF-8; keep the remaining diagnostic.
        // swiftlint:disable:next optional_data_string_conversion
        let line = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !line.hasPrefix(Self.dangerBannerPrefix) else { return }
        self.emit(.error(line))
    }
}
