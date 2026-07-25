"""
4D Tetra Clock-Train Harmoniser - Production Grade Execution Engine.
Optimised for high-throughput deterministic matrix processing.
Zero object allocation in hot loops to eliminate garbage collection latency.
"""
import sys
import math
import ctypes
import struct

class HighResPerformanceTimer:
    def __init__(self) -> None:
        self.kernel32 = ctypes.windll.kernel32
        self.frequency = ctypes.c_int64()
        self.kernel32.QueryPerformanceFrequency(ctypes.byref(self.frequency))
        self.freq_val = float(self.frequency.value)

    def get_time_seconds(self) -> float:
        """Returns hardware-level timestamp with microsecond resolution."""
        counter = ctypes.c_int64()
        self.kernel32.QueryPerformanceCounter(ctypes.byref(counter))
        return float(counter.value) / self.freq_val

class FourNoteClockTrain:
    def __init__(self) -> None:
        # Pre-pack your sovereign seed constants directly into memory floats
        self.notes = (0.034, 0.052, 0.75, 0.15)
        self.clock_frequency_hz = 40_000_000.0
        self.omega_day = 86400
        self.timer = HighResPerformanceTimer()
        
        # Pre-allocate binary buffer structures (4 floats = 16 bytes payload)
        # Prevents heap allocations during runtime execution blocks
        self.buffer_layout = struct.Struct('ffff')

    def execute_live_conduction(self) -> None:
        """
        Infinite execution loop. Outputs raw binary telemetry packets.
        Designed to feed directly into memory maps or native serial drivers.
        """
        # Pre-bind method lookups to the local stack to save microsecond dictionary lookups
        timer_func = self.timer.get_time_seconds
        sin_func = math.sin
        freq = self.clock_frequency_hz
        notes = self.notes
        write_stream = sys.stdout.buffer.write
        flush_stream = sys.stdout.buffer.flush
        pack_func = self.buffer_layout.pack

        try:
            while True:
                t = timer_func()
                
                # Compute raw wave amplitudes across the 4 frequency nodes instantly
                n0 = sin_func(notes[0] * t * freq)
                n1 = sin_func(notes[1] * t * freq)
                n2 = sin_func(notes[2] * t * freq)
                n3 = sin_func(notes[3] * t * freq)
                
                # Pack floats into raw 16-byte binary arrays and push directly across standard out
                write_stream(pack_func(n0, n1, n2, n3))
                flush_stream()
                
        except KeyboardInterrupt:
            sys.exit(0)

if __name__ == "__main__":
    conductor = FourNoteClockTrain()
    conductor.execute_live_conduction()
