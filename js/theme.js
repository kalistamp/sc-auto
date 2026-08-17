/* ============================================================
   SAFE CYCLE STUDIO — theme

   Three states, not two. "System" is the default and genuinely
   follows the OS, including a change made while the tab is open —
   which is why the media-query listener stays attached rather than
   being read once at boot.

   The class lives on <html>, not <body>, so the inline bootstrap in
   index.html can set it before the first paint. Putting it on <body>
   would flash a full white page on every load in dark mode.
   ============================================================ */

import { readPrefs, writePrefs } from "./settings.js";

const KEY = "sct.theme";           /* read by the bootstrap script in index.html */
const media = window.matchMedia("(prefers-color-scheme: dark)");

export const THEMES = ["system", "light", "dark"];

export function currentTheme() {
  return readPrefs().theme || "system";
}

export function resolvedTheme() {
  const theme = currentTheme();
  return theme === "system" ? (media.matches ? "dark" : "light") : theme;
}

export function applyTheme(theme = currentTheme()) {
  const dark = theme === "dark" || (theme === "system" && media.matches);
  document.documentElement.classList.toggle("theme-dark", dark);
  /* Keep the address bar and any OS chrome in step with the page. */
  let tag = document.querySelector('meta[name="theme-color"]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "theme-color";
    document.head.append(tag);
  }
  tag.content = dark ? "#161815" : "#f4f1e9";
}

export function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "system";
  writePrefs({ theme: next });
  /* The bootstrap script reads this bare key, so it has to be written
     separately from the preferences blob it also lives in. */
  try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  applyTheme(next);
  return next;
}

/* The topbar button is a two-state toggle over a three-state setting:
   it flips between light and dark, and picking "system" is done in
   Settings. That keeps the common action to one click. */
export function toggleTheme() {
  return setTheme(resolvedTheme() === "dark" ? "light" : "dark");
}

export function watchSystemTheme(onChange) {
  media.addEventListener("change", () => {
    if (currentTheme() === "system") { applyTheme("system"); onChange?.(); }
  });
}
