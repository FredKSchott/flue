const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function withBase(href: string): string;
export function withBase(href: undefined): undefined;
export function withBase(href: string | undefined): string | undefined;
export function withBase(href: string | undefined): string | undefined {
  if (!href) return href;
  if (/^([a-z][a-z0-9+.\-]*:|\/\/)/i.test(href)) return href;
  if (href.startsWith("#") || href.startsWith("?")) return href;
  if (!href.startsWith("/")) return href;
  if (!BASE) return href;
  if (href === BASE || href.startsWith(`${BASE}/`)) return href;
  return `${BASE}${href}`;
}
