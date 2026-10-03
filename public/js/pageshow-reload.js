// Watching page only: reload when restored from the back/forward cache so a
// button disabled by data-disable-on-submit doesn't stay stuck.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
