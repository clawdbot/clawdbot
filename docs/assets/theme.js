const THEME_STORAGE_KEY = "moltbot:theme";

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function preferredTheme() {
  const stored = safeGet(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;

  const toggle = document.querySelector("[data-theme-toggle]");
  const label = document.querySelector("[data-theme-label]");

  if (toggle instanceof HTMLButtonElement) toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  if (label) label.textContent = theme === "dark" ? "dark" : "light";
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  safeSet(THEME_STORAGE_KEY, next);
  applyTheme(next);
}

applyTheme(preferredTheme());

document.addEventListener("click", (event) => {
  const target = event.target;
  const button = target instanceof Element ? target.closest("[data-theme-toggle]") : null;
  if (button) toggleTheme();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "F2") {
    event.preventDefault();
    toggleTheme();
  }
});
