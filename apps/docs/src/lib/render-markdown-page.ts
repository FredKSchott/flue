import { renderEntryAsMarkdown, type IndexedEntry } from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";
import { withBase } from "@/lib/with-base";

export function renderMarkdownPage(item: IndexedEntry): string {
  const { entry, title, description, version } = item;
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const rawImage = data.socialImage;
  const socialImage =
    typeof rawImage === "string" && rawImage.length > 0 ? rawImage : config.socialImage;

  const markdown = renderEntryAsMarkdown(entry);

  return [
    "---",
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    `title: ${JSON.stringify(`${title} | ${config.title}`)}`,
    ...(socialImage
      ? [`image: ${JSON.stringify(new URL(withBase(socialImage), config.site).href)}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    markdown,
    "",
  ].join("\n");
}
