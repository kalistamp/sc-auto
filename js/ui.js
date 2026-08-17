/* ============================================================
   SAFE CYCLE STUDIO — DOM utilities

   Rendering is string templates written into one container. That keeps
   the project buildless and the markup readable, at the cost of two
   things this module exists to handle: escaping every value that goes
   into HTML, and putting the caret back where it was afterwards.
   ============================================================ */

import { UNDO_MS } from "./config.js";

export const el = (selector, root = document) => root.querySelector(selector);
export const els = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ------------------------------------------------------------
   ESCAPING

   Every interpolation into a template goes through one of these. The
   rule is simple: `esc` for text, `safeUrl` for anything that becomes
   an href — escaping alone does not stop `javascript:` from running.
   ------------------------------------------------------------ */

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

export function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}

export function icon(name, extra = "") {
  return `<svg class="ico ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/* ------------------------------------------------------------
   FORMATTING
   ------------------------------------------------------------ */

export function fmtDate(value, { withYear = true } = {}) {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {})
  }).format(date);
}

export function fmtDayHeading(value) {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

export function fmtTime(value) {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function fmtDateTime(value) {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  }).format(date);
}

export function relTime(value) {
  const date = toDate(value);
  if (!date) return "—";
  const delta = Date.now() - date.getTime();
  const future = delta < 0;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`;
  return fmtDate(date);
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* <input type="datetime-local"> speaks local wall-clock time with no
   zone; the workspace stores UTC ISO strings. These two are the only
   places that conversion is allowed to happen. */
export function toLocalInput(value) {
  const date = toDate(value);
  if (!date) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

export function fromLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/* ------------------------------------------------------------
   FOCUS RETENTION

   Only #view is re-rendered, but a re-render triggered while someone
   is typing in a search box or a draft still destroys the node under
   the caret. Capturing the focused element's id and selection, then
   restoring both, makes every re-render safe to call from anywhere.
   ------------------------------------------------------------ */

export function withFocusRetained(render) {
  const active = document.activeElement;
  const id = active?.id;
  const canSelect = active && "selectionStart" in active;
  const start = canSelect ? active.selectionStart : null;
  const end = canSelect ? active.selectionEnd : null;
  const scrollTop = active?.scrollTop;

  render();

  if (!id) return;
  const next = document.getElementById(id);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (start != null && "setSelectionRange" in next) {
    try { next.setSelectionRange(start, end); } catch { /* not a text field any more */ }
  }
  if (scrollTop != null) next.scrollTop = scrollTop;
}

/* ------------------------------------------------------------
   TOAST — one at a time, with an optional single action (Undo).
   ------------------------------------------------------------ */

let toastTimer = null;

export function toast(text, { kind = "", action = "", onAction = null, ms = 4200 } = {}) {
  const node = el("#toast");
  const label = el("#toast-text");
  const button = el("#toast-action");

  clearTimeout(toastTimer);
  label.textContent = text;
  node.className = `toast${kind ? ` is-${kind}` : ""}`;
  node.hidden = false;

  button.hidden = !action;
  button.onclick = null;
  if (action) {
    button.innerHTML = `${icon("undo")}${esc(action)}`;
    button.onclick = () => { hideToast(); onAction?.(); };
  }

  toastTimer = setTimeout(hideToast, action ? UNDO_MS : ms);
}

export function hideToast() {
  clearTimeout(toastTimer);
  const node = el("#toast");
  if (node) node.hidden = true;
}

/* ------------------------------------------------------------
   MODALS

   <dialog> rather than a div, because the browser gives the focus
   trap, the inert background, the top layer and Esc handling for free.
   ------------------------------------------------------------ */

/* One listener per dialog, attached once. A per-open `{once:true}`
   listener races with an immediate reopen (close events are queued as
   tasks), which would strip the scroll lock out from under a dialog
   that is still on screen. */
for (const id of typeof document === "undefined" ? [] : ["#modal", "#confirm"]) {
  el(id)?.addEventListener("close", () => {
    const stillOpen = el("#modal")?.open || el("#confirm")?.open;
    if (!stillOpen) document.body.classList.remove("is-locked");
  });
}

export function openModal(html, { size = "", onMount = null } = {}) {
  const dialog = el("#modal");
  dialog.className = `modal${size ? ` modal-${size}` : ""}`;
  dialog.innerHTML = html;
  dialog.querySelectorAll("[data-close]").forEach((node) => {
    node.addEventListener("click", () => dialog.close());
  });
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("is-locked");
  onMount?.(dialog);
  /* Send focus somewhere useful rather than to the close button. */
  const first = dialog.querySelector("[data-autofocus], input:not([type=hidden]), textarea, select");
  first?.focus();
  return dialog;
}

export function closeModal() {
  const dialog = el("#modal");
  if (dialog.open) dialog.close();
}

export function confirmAction({ title, body, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const dialog = el("#confirm");
    dialog.className = "modal modal-sm";
    dialog.innerHTML = `
      <div class="modal-inner">
        <div class="modal-head">
          <div>
            <h2>${esc(title)}</h2>
            <p>${esc(body)}</p>
          </div>
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button class="btn btn-ghost" type="button" data-no>Cancel</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-yes data-autofocus>${esc(confirmLabel)}</button>
        </div>
      </div>`;

    let answer = false;
    dialog.querySelector("[data-yes]").addEventListener("click", () => { answer = true; dialog.close(); });
    dialog.querySelector("[data-no]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => resolve(answer), { once: true });
    dialog.showModal();
    dialog.querySelector("[data-yes]").focus();
  });
}

/* ------------------------------------------------------------
   CLIPBOARD AND FILES
   ------------------------------------------------------------ */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* Safari refuses the async clipboard outside a short user-gesture
       window, and http:// origins have no clipboard API at all. */
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch { return false; }
  }
}

export function downloadFile(filename, contents, mime = "application/json") {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
