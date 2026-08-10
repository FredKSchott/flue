import { getIndexedEntries } from "@cloudflare/nimbus-docs";
import { renderMarkdownPage } from "@/lib/render-markdown-page";

export const prerender = true;

export async function GET() {
  const indexed = await getIndexedEntries();
  const item = indexed.find(
    (entry) => entry.collection === "guide" && entry.entry.id === "getting-started",
  );
  if (!item) throw new Error("index.md: missing guide/getting-started entry");

  return new Response(renderMarkdownPage(item), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
