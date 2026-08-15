#if canImport(Darwin)
import Darwin

enum ProcessSocketListenerInspector {
    private static let initialDescriptorCapacity = 64

    static func isListening(pid: pid_t, port: UInt16) -> Bool {
        guard pid > 0 else { return false }

        var capacity = self.initialDescriptorCapacity
        let capacityLimit = self.descriptorCapacityLimit()
        while true {
            var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: capacity)
            let populatedBytes = descriptors.withUnsafeMutableBytes { buffer in
                proc_pidinfo(
                    pid,
                    PROC_PIDLISTFDS,
                    0,
                    buffer.baseAddress,
                    Int32(buffer.count))
            }
            guard populatedBytes > 0 else { return false }

            let populatedByteCount = Int(populatedBytes)
            let descriptorStride = MemoryLayout<proc_fdinfo>.stride
            let descriptorCount = min(capacity, populatedByteCount / descriptorStride)
            for descriptor in descriptors.prefix(descriptorCount)
                where descriptor.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET)
            {
                if self.isListeningSocket(pid: pid, descriptor: descriptor.proc_fd, port: port) {
                    return true
                }
            }

            // A full result may be truncated. Grow and rescan so listeners with
            // high-numbered descriptors are not reported as absent.
            guard populatedByteCount >= descriptors.count * descriptorStride else { return false }
            guard capacity < capacityLimit else { return false }
            capacity = min(capacity * 2, capacityLimit)
        }
    }

    private static func descriptorCapacityLimit() -> Int {
        let bufferLimit = Int(Int32.max) / MemoryLayout<proc_fdinfo>.stride
        var descriptorLimit = rlimit()
        // The inspected SSH process is our child and inherits this soft limit.
        // Scanning to that ceiling is exhaustive without an arbitrary allocation cap.
        guard getrlimit(RLIMIT_NOFILE, &descriptorLimit) == 0,
              descriptorLimit.rlim_cur != rlim_t(Int64.max)
        else {
            return bufferLimit
        }
        return max(
            self.initialDescriptorCapacity,
            min(Int(clamping: descriptorLimit.rlim_cur), bufferLimit))
    }

    private static func isListeningSocket(pid: pid_t, descriptor: Int32, port: UInt16) -> Bool {
        var socket = socket_fdinfo()
        let populatedBytes = withUnsafeMutableBytes(of: &socket) { buffer in
            proc_pidfdinfo(
                pid,
                descriptor,
                PROC_PIDFDSOCKETINFO,
                buffer.baseAddress,
                Int32(buffer.count))
        }
        guard Int(populatedBytes) == MemoryLayout<socket_fdinfo>.stride,
              socket.psi.soi_kind == SOCKINFO_TCP,
              socket.psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN
        else {
            return false
        }

        let localPort = UInt16(
            bigEndian: UInt16(
                truncatingIfNeeded: socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport))
        return localPort == port
    }
}
#endif
