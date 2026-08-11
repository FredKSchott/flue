import { lockScroll, mount, unlockScroll } from "@cloudflare/nimbus-docs/client";

mount("[data-dialog]", (root) => {
  if (!(root instanceof HTMLDialogElement)) return () => {};
  const dialog = root;

  const sync = () => (dialog.open ? lockScroll() : unlockScroll());
  const observer = new MutationObserver(sync);
  observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });

  const onBackdrop = (e: MouseEvent) => {
    if (e.target === dialog) dialog.close();
  };
  dialog.addEventListener("click", onBackdrop);

  return () => {
    observer.disconnect();
    dialog.removeEventListener("click", onBackdrop);
    // A swap while open never fires the observer; balance the scroll lock.
    if (dialog.open) unlockScroll();
  };
});
