const FIRST_REPLY_CONFETTI_KEY = "openclaw.confetti.firstReply";
const CONFETTI_COLORS = ["#ff4d4d", "#ff7079", "#00e5cc", "#f2a833"] as const;
const CONFETTI_DURATION_MS = 1_500;
const PARTICLE_COUNT = 64;

type ConfettiStorage = Pick<Storage, "getItem" | "setItem">;

type ConfettiParticle = {
  color: (typeof CONFETTI_COLORS)[number];
  angle: number;
  speed: number;
  size: number;
  spin: number;
  rotation: number;
};

function shouldFireFirstReplyConfetti(storage: ConfettiStorage): boolean {
  try {
    if (storage.getItem(FIRST_REPLY_CONFETTI_KEY) !== null) {
      return false;
    }
    storage.setItem(FIRST_REPLY_CONFETTI_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

function createParticles(): ConfettiParticle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, index) => ({
    // noUncheckedIndexedAccess cannot see the modulo bound; index 0 is typed.
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length] ?? CONFETTI_COLORS[0],
    angle: -Math.PI * (0.2 + Math.random() * 0.6),
    speed: 260 + Math.random() * 360,
    size: 4 + Math.random() * 5,
    spin: (Math.random() - 0.5) * 12,
    rotation: Math.random() * Math.PI,
  }));
}

export function fireFirstReplyConfetti(): void {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    !document.body ||
    typeof window.requestAnimationFrame !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return;
  }
  if (!shouldFireFirstReplyConfetti(storage)) {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  document.body.append(canvas);

  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const particles = createParticles();
  const origin = { x: width / 2, y: height * 0.62 };
  const startedAt = performance.now();
  const draw = (timestamp: number) => {
    const elapsedMs = timestamp - startedAt;
    const elapsed = elapsedMs / 1_000;
    const progress = elapsedMs / CONFETTI_DURATION_MS;
    context.clearRect(0, 0, width, height);
    context.globalAlpha = progress < 0.65 ? 1 : Math.max(0, (1 - progress) / 0.35);

    for (const particle of particles) {
      const drag = Math.max(0, 1 - elapsed * 0.22);
      const x = origin.x + Math.cos(particle.angle) * particle.speed * elapsed * drag;
      const y =
        origin.y + Math.sin(particle.angle) * particle.speed * elapsed + 420 * elapsed * elapsed;
      context.save();
      context.translate(x, y);
      context.rotate(particle.rotation + particle.spin * elapsed);
      context.fillStyle = particle.color;
      context.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
      context.restore();
    }

    if (progress < 1) {
      window.requestAnimationFrame(draw);
    } else {
      canvas.remove();
    }
  };
  window.requestAnimationFrame(draw);
}
