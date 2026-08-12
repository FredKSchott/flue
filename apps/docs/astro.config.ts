import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  site: "https://flueframework.com",
  title: "Flue",
  description:
    "The open agent framework, from the creators of Astro. Build agents in TypeScript with a React-like hooks API.",
  locale: "en",
  github: "https://github.com/withastro/flue",
  socialImage: "/docs/og4.jpg",
  socialImageAlt: "Flue framework logo",
  // Favicon set + PWA manifest, base-prefixed to match `base: "/docs"`.
  // NimbusHead already emits the SVG icon link (favicon.svg exists in
  // public/); these add the PNG icon, the .ico fallback, the iOS touch
  // icon, and the web manifest that the hand-rolled DocsLayout wired
  // before the migration.
  head: [
    { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "96x96", href: "/docs/favicon-96x96.png" } },
    { tag: "link", attrs: { rel: "shortcut icon", href: "/docs/favicon.ico" } },
    { tag: "link", attrs: { rel: "apple-touch-icon", sizes: "180x180", href: "/docs/apple-touch-icon.png" } },
    { tag: "link", attrs: { rel: "manifest", href: "/docs/site.webmanifest" } },
  ],
  sidebar: {
    scope: "section",
    items: [
      {
        label: "Guide",
        icon: "ph:book-open",
        segment: "/guide",
        landing: "/guide/getting-started/",
        items: [
          {
            label: "Introduction",
            items: [
              { label: "Getting Started", link: "/guide/getting-started/" },
              { label: "Why Flue?", link: "/guide/why-flue/" },
              { label: "Migration Guide", link: "/guide/migration/" },
              { label: "Changelog", link: "https://github.com/withastro/flue/blob/main/CHANGELOG.md" },
            ],
          },
          {
            label: "Guides",
            items: [
              { label: "Project Layout", link: "/guide/project-layout/" },
              { label: "Agents", link: "/guide/building-agents/" },
              { label: "Agent Hooks", link: "/guide/agent-hooks/" },
              { label: "Models", link: "/guide/models/" },
              { label: "Tools", link: "/guide/tools/" },
              { label: "MCP", link: "/guide/mcp/" },
              { label: "Skills", link: "/guide/skills/" },
              { label: "Subagents", link: "/guide/subagents/" },
              { label: "Sandboxes", link: "/guide/sandboxes/" },
              { label: "Routing", link: "/guide/routing/" },
              { label: "Database", link: "/guide/database/" },
            ],
          },
          {
            label: "Advanced",
            items: [
              { label: "Deploy", link: "/guide/deploy/" },
              { label: "Workflows", link: "/guide/workflows/" },
              { label: "Schedules", link: "/guide/schedules/" },
              { label: "Channels", link: "/guide/channels/" },
              { label: "Evals", link: "/guide/evals/" },
              { label: "Observability", link: "/guide/observability/" },
              { label: "Durability", link: "/guide/durability/" },
            ],
          },
          {
            label: "Frontend",
            items: [{ label: "React", link: "/guide/react/" }],
          },
          {
            label: "Targets",
            items: [
              { label: "Cloudflare", link: "/guide/cloudflare-target/" },
              { label: "Node.js", link: "/guide/node-target/" },
            ],
          },
        ],
      },
      {
        label: "Reference",
        icon: "ph:brackets-curly",
        segment: "/reference",
        landing: "/reference/agent-api/",
        items: [
          {
            label: "Runtime",
            items: [
              { label: "Configuration", link: "/reference/configuration/" },
              { label: "Errors Reference", link: "/reference/errors/" },
              { label: "Agent API", link: "/reference/agent-api/" },
              { label: "Agent Hooks API", link: "/reference/agent-hooks-api/" },
              { label: "Agent Behavior", link: "/reference/agent-behavior/" },
              { label: "Provider API", link: "/reference/provider-api/" },
              { label: "Streaming Protocol", link: "/reference/streaming-protocol/" },
              { label: "Events Reference", link: "/reference/events/" },
            ],
          },
          {
            label: "Advanced",
            items: [
              { label: "Sandbox Adapter API", link: "/reference/sandbox-api/" },
              { label: "Data Persistence API", link: "/reference/data-persistence-api/" },
            ],
          },
        ],
      },
      {
        label: "CLI",
        icon: "ph:terminal-window",
        segment: "/cli",
        landing: "/cli/overview/",
        items: [
          {
            label: "CLI",
            items: [
              { label: "Overview", link: "/cli/overview/" },
              { label: "init", link: "/cli/init/" },
              { label: "run", link: "/cli/run/" },
              { label: "add", link: "/cli/add/" },
              { label: "update", link: "/cli/update/" },
              { label: "docs", link: "/cli/docs/" },
            ],
          },
        ],
      },
      {
        label: "Agent SDK",
        icon: "ph:cube",
        segment: "/sdk",
        landing: "/sdk/overview/",
        items: [
          {
            label: "Agent SDK",
            items: [
              { label: "Overview", link: "/sdk/overview/" },
              { label: "createFlueClient(...)", link: "/sdk/create-flue-client/" },
              { label: "FlueClient", link: "/sdk/flue-client/" },
              { label: "Events", link: "/sdk/events/" },
              { label: "Errors", link: "/sdk/errors/" },
            ],
          },
        ],
      },
      {
        label: "Ecosystem",
        icon: "ph:plugs-connected",
        segment: "/ecosystem",
        landing: "/ecosystem/",
        items: [
          { label: "Overview", link: "/ecosystem/" },
          {
            label: "Channels",
            items: [
              { label: "Discord", link: "/ecosystem/channels/discord/" },
              { label: "Facebook", link: "/ecosystem/channels/messenger/" },
              { label: "GitHub", link: "/ecosystem/channels/github/" },
              { label: "Google Chat", link: "/ecosystem/channels/google-chat/" },
              { label: "Intercom", link: "/ecosystem/channels/intercom/" },
              { label: "Linear", link: "/ecosystem/channels/linear/" },
              { label: "Microsoft Teams", link: "/ecosystem/channels/teams/" },
              { label: "Notion", link: "/ecosystem/channels/notion/" },
              { label: "Resend", link: "/ecosystem/channels/resend/" },
              { label: "Salesforce", link: "/ecosystem/channels/salesforce-marketing-cloud/" },
              { label: "Shopify", link: "/ecosystem/channels/shopify/" },
              { label: "Slack", link: "/ecosystem/channels/slack/" },
              { label: "Stripe", link: "/ecosystem/channels/stripe/" },
              { label: "Telegram", link: "/ecosystem/channels/telegram/" },
              { label: "Twilio", link: "/ecosystem/channels/twilio/" },
              { label: "WhatsApp", link: "/ecosystem/channels/whatsapp/" },
              { label: "Zendesk", link: "/ecosystem/channels/zendesk/" },
            ],
          },
          {
            label: "Sandboxes",
            items: [
              { label: "boxd", link: "/ecosystem/sandboxes/boxd/" },
              { label: "Cloudflare Computer", link: "/ecosystem/sandboxes/cloudflare-computer/" },
              { label: "Cloudflare Sandbox", link: "/ecosystem/sandboxes/cloudflare/" },
              { label: "Daytona", link: "/ecosystem/sandboxes/daytona/" },
              { label: "E2B", link: "/ecosystem/sandboxes/e2b/" },
              { label: "exe.dev", link: "/ecosystem/sandboxes/exedev/" },
              { label: "islo", link: "/ecosystem/sandboxes/islo/" },
              { label: "Mirage", link: "/ecosystem/sandboxes/mirage/" },
              { label: "Modal", link: "/ecosystem/sandboxes/modal/" },
              { label: "Vercel Sandbox", link: "/ecosystem/sandboxes/vercel/" },
            ],
          },
          {
            label: "Deploy",
            items: [
              { label: "AWS", link: "/ecosystem/deploy/aws/" },
              { label: "Cloudflare", link: "/ecosystem/deploy/cloudflare/" },
              { label: "Docker", link: "/ecosystem/deploy/docker/" },
              { label: "Fly.io", link: "/ecosystem/deploy/fly/" },
              { label: "GitHub Actions", link: "/ecosystem/deploy/github-actions/" },
              { label: "GitLab CI/CD", link: "/ecosystem/deploy/gitlab-ci/" },
              { label: "Node.js", link: "/ecosystem/deploy/node/" },
              { label: "Railway", link: "/ecosystem/deploy/railway/" },
              { label: "Render", link: "/ecosystem/deploy/render/" },
              { label: "SST", link: "/ecosystem/deploy/sst/" },
            ],
          },
          {
            label: "Databases",
            items: [
              { label: "libSQL", link: "/ecosystem/databases/libsql/" },
              { label: "MongoDB", link: "/ecosystem/databases/mongodb/" },
              { label: "MySQL", link: "/ecosystem/databases/mysql/" },
              { label: "Postgres", link: "/ecosystem/databases/postgres/" },
              { label: "Redis", link: "/ecosystem/databases/redis/" },
              { label: "Supabase", link: "/ecosystem/databases/supabase/" },
              { label: "Turso", link: "/ecosystem/databases/turso/" },
              { label: "Valkey", link: "/ecosystem/databases/valkey/" },
            ],
          },
          {
            label: "Tooling",
            items: [
              { label: "Braintrust", link: "/ecosystem/tooling/braintrust/" },
              { label: "Jetty", link: "/ecosystem/tooling/jetty/" },
              { label: "OpenTelemetry", link: "/ecosystem/tooling/opentelemetry/" },
              { label: "Sentry", link: "/ecosystem/tooling/sentry/" },
              { label: "Vitest Evals", link: "/ecosystem/tooling/vitest-evals/" },
            ],
          },
        ],
      },
    ],
  },
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  site: "https://flueframework.com",
  base: "/docs",
  trailingSlash: "always",
  outDir: "./dist/docs",
  // Flue has no landing at the docs root; it 302s to the first guide page.
  redirects: {
    "/": { status: 302, destination: "/docs/guide/getting-started/" },
  },
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
