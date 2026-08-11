import { getSidebarSections } from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";
import { stripBase } from "@/lib/with-base";

export interface NavSection {
  label: string;
  href: string;
  isActive: boolean;
}

function firstLink(items: any[] | undefined): string | undefined {
  for (const it of items ?? []) {
    if (typeof it?.link === "string" && !/^([a-z][a-z0-9+.\-]*:|\/\/)/i.test(it.link)) return it.link;
    if (Array.isArray(it?.items)) {
      const r = firstLink(it.items);
      if (r) return r;
    }
  }
  return undefined;
}

export async function getNavSections(pathname: string, collection?: string): Promise<NavSection[]> {
  const rel = stripBase(pathname);
  const currentSeg = `/${rel.split("/").filter(Boolean)[0] ?? ""}`;

  const configItems = (config.sidebar?.items ?? []) as Array<Record<string, unknown>>;
  let sections: NavSection[] = configItems
    .filter((it) => it && typeof it === "object" && typeof it.segment === "string")
    .map((it) => {
      const seg = (it.segment as string).startsWith("/") ? (it.segment as string) : `/${it.segment}`;
      const href = (typeof it.landing === "string" ? it.landing : undefined) ?? firstLink(it.items as any[]) ?? seg;
      return { label: it.label as string, href, isActive: seg === currentSeg };
    });

  if (sections.length < 2) {
    const currentSlug = pathname.replace(/\/$/, "") || "/";
    sections = await getSidebarSections(currentSlug, { collection });
  }

  return sections;
}
