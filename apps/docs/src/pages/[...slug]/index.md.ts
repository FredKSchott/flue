import { getIndexedEntries, type IndexedEntry } from "@cloudflare/nimbus-docs";
import { renderMarkdownPage } from "@/lib/render-markdown-page";

export const prerender = true;

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const sections = ["guide", "reference", "cli", "sdk", "ecosystem"];
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => sections.includes(item.collection))
    .map((item) => ({
      params: { slug: `${item.collection}/${item.entry.id}` },
      props: { item } as SlugProps,
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  return new Response(renderMarkdownPage(props.item), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
