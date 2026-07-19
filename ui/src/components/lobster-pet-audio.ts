export type LobsterPetChirpKind = "poke" | "pet";

// Opt-in (default off) tiny synth chirps: a descending blub for pokes, a
// rising coo for pets. Only ever called from pointer gestures, so the
// AudioContext is created inside a user activation and never blocked by
// autoplay policy. Sound is decoration - any audio failure is swallowed.
export function playLobsterPetChirp(
  audioCtx: AudioContext | null,
  soundsEnabled: boolean,
  kind: LobsterPetChirpKind,
): AudioContext | null {
  let ctx = audioCtx;
  if (!soundsEnabled) {
    return ctx;
  }
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) {
      return ctx;
    }
    ctx ??= new Ctor();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const at = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    if (kind === "poke") {
      osc.frequency.setValueAtTime(330, at);
      osc.frequency.exponentialRampToValueAtTime(165, at + 0.09);
    } else {
      osc.frequency.setValueAtTime(392, at);
      osc.frequency.exponentialRampToValueAtTime(523, at + 0.18);
    }
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + (kind === "poke" ? 0.12 : 0.24));
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.26);
  } catch {
    // never let audio break the pet
  }
  return ctx;
}
