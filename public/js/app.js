// Loaded by Layout (`<script src="/js/app.js" defer>`). Everything here is
// delegated or null-guarded so one missing element can't kill the other
// handlers. No inline scripts/handlers exist anywhere (strict CSP).

function handleWatchLinkClick(e) {
  const link = e.target.closest(".watch-link");
  if (!link) return;
  if (e.type === "auxclick" && e.button !== 1) return;
  if (e.type === "click" && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
  window.open(link.dataset.youtubeUrl, "_blank", "noopener");
}
document.addEventListener("click", handleWatchLinkClick);
document.addEventListener("auxclick", handleWatchLinkClick);

function toggleSidebar() {
  const aside = document.getElementById("sidebar");
  const btn = document.getElementById("sidebar-toggle");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (!aside || !btn || !backdrop) return;
  const isOpen = aside.dataset.open === "true";
  aside.dataset.open = String(!isOpen);
  backdrop.dataset.open = String(!isOpen);
  btn.setAttribute("aria-expanded", String(!isOpen));
}
document
  .getElementById("sidebar-toggle")
  ?.addEventListener("click", toggleSidebar);
document
  .getElementById("sidebar-backdrop")
  ?.addEventListener("click", toggleSidebar);

// `error` doesn't bubble, so listen in the capture phase. Covers images HTMX
// swaps in later (endless scroll) with no extra hook.
document.addEventListener(
  "error",
  (e) => {
    if (e.target instanceof HTMLImageElement) {
      e.target.style.visibility = "hidden";
    }
  },
  true,
);
// Images that already errored before this deferred script ran.
for (const img of document.querySelectorAll("img")) {
  if (img.complete && img.naturalWidth === 0) {
    img.style.visibility = "hidden";
  }
}

document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!form.hasAttribute("data-disable-on-submit")) return;
  const button = form.querySelector("button");
  if (button) button.disabled = true;
});
