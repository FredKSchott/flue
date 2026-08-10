import { config } from "virtual:nimbus/config";
import {
  channels,
  databases,
  deploy,
  ecosystemMeta,
  sandboxes,
  tooling,
  type EcosystemItem,
} from "@/lib/ecosystem-catalog";

export const prerender = true;

const sections: { heading: string; items: EcosystemItem[] }[] = [
  { heading: "Channels", items: channels },
  { heading: "Sandboxes", items: sandboxes },
  { heading: "Deploy", items: deploy },
  { heading: "Databases", items: databases },
  { heading: "Tooling", items: tooling },
];

export async function GET() {
  const socialImage = config.socialImage
    ? new URL(config.socialImage, config.site).href
    : undefined;

  const lines = [
    "---",
    `description: ${JSON.stringify(ecosystemMeta.description)}`,
    `title: ${JSON.stringify(`${ecosystemMeta.title} | ${config.title}`)}`,
    ...(socialImage ? [`image: ${JSON.stringify(socialImage)}`] : []),
    "---",
    "",
    `# ${ecosystemMeta.title}`,
    "",
    ecosystemMeta.intro,
    "",
  ];

  for (const { heading, items } of sections) {
    lines.push(`## ${heading}`, "");
    for (const item of items) {
      lines.push(`- [${item.name}](${new URL(item.href, config.site).href})`);
    }
    lines.push("");
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
