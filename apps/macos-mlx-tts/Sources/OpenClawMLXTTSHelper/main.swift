import Darwin
import Foundation
import OpenClawMLXTTSProtocol
import OpenClawMLXTTSRuntime

@main
enum OpenClawMLXTTSHelper {
    static func main() async {
        do {
            let protocolOutput = try Self.makeProtocolOutput()
            let writer = FrameWriter(output: protocolOutput)
            let service = MLXTTSHelperService { event in
                do {
                    try await writer.write(event)
                } catch {
                    Self.log("failed to write event: \(error)")
                }
            }

            try await writer.write(MLXTTSEvent.ready)
            try await Self.readRequests(service: service, writer: writer)
        } catch {
            self.log("\(error)")
            exit(1)
        }
    }

    private static func makeProtocolOutput() throws -> FileHandle {
        let protocolFD = dup(STDOUT_FILENO)
        guard protocolFD >= 0 else {
            throw POSIXError(.EBADF)
        }
        guard dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 else {
            close(protocolFD)
            throw POSIXError(.EBADF)
        }
        return FileHandle(fileDescriptor: protocolFD, closeOnDealloc: true)
    }

    private static func readRequests(service: MLXTTSHelperService, writer: FrameWriter) async throws {
        let input = FileHandle.standardInput
        let (chunks, continuation) = AsyncStream<Data>.makeStream()
        input.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                continuation.finish()
            } else {
                continuation.yield(data)
            }
        }
        defer {
            input.readabilityHandler = nil
            continuation.finish()
        }

        var decoder = MLXTTSFrameDecoder()
        for await chunk in chunks {
            for payload in try decoder.append(chunk) {
                let request: MLXTTSRequest
                do {
                    request = try MLXTTSFrameCodec.decode(MLXTTSRequest.self, payload: payload)
                } catch {
                    try await writer.write(MLXTTSEvent.error(MLXTTSErrorEvent(
                        id: nil,
                        code: .protocolError,
                        message: "invalid request frame")))
                    continue
                }

                if await !(service.handle(request)) {
                    return
                }
            }
        }

        _ = await service.handle(.shutdown)
    }

    private static func log(_ message: String) {
        FileHandle.standardError.write(Data("openclaw-mlx-tts: \(message)\n".utf8))
    }
}

private actor FrameWriter {
    let output: FileHandle

    init(output: FileHandle) {
        self.output = output
    }

    func write(_ event: MLXTTSEvent) throws {
        try self.output.write(contentsOf: MLXTTSFrameCodec.encode(event))
    }
}
