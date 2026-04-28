import Foundation
import Network
import os

enum TCPProbe {
    static func probe(host: String, port: Int, timeoutSeconds: Double, queueLabel: String) async -> Bool {
        guard port >= 1, port <= 65535 else { return false }
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }

        let endpointHost = NWEndpoint.Host(host)
        let connection = NWConnection(host: endpointHost, port: nwPort, using: .tcp)

        return await withCheckedContinuation { cont in
            let queue = DispatchQueue(label: queueLabel)
            let finished = OSAllocatedUnfairLock(initialState: false)
            let finish: @Sendable (Bool) -> Void = { ok in
                let shouldResume = finished.withLock { flag -> Bool in
                    if flag { return false }
                    flag = true
                    return true
                }
                guard shouldResume else { return }
                connection.cancel()
                cont.resume(returning: ok)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(true)
                case .failed, .cancelled:
                    finish(false)
                default:
                    break
                }
            }

            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeoutSeconds) { finish(false) }
        }
    }
}
