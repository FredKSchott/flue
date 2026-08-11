import { mount } from "@cloudflare/nimbus-docs/client";

const STORAGE_KEY = "sidebar-state";

interface SidebarState {
  hash: string;
  scroll: number;
}

function initSidebar(root: HTMLElement): () => void {
  if (!root.hasAttribute("data-nb-sidebar-persist")) return () => {};
  return initPersistence(root);
}

function initPersistence(root: HTMLElement): () => void {
  const scrollHost: HTMLElement = root.closest("aside") ?? root;
  const hash = root.dataset.nbSidebarHash ?? "";

  function readState(): SidebarState {
    return { hash, scroll: scrollHost.scrollTop };
  }

  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(readState()));
    } catch {}
  }

  function handleVisibility() {
    if (document.visibilityState === "hidden") save();
  }
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", save);

  let raf = 0;
  function handleScroll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(save);
  }
  scrollHost.addEventListener("scroll", handleScroll);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("pagehide", save);
    scrollHost.removeEventListener("scroll", handleScroll);
    cancelAnimationFrame(raf);
  };
}

mount("[data-nb-sidebar]", initSidebar);
