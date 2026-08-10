import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

const flueFields = {
  lastReviewedAt: z.coerce.date().optional(),
  subtitle: z.string().optional(),
  package: z.object({ name: z.string(), href: z.string().url() }).optional(),
};

const section = (base: string) =>
  defineCollection(docsCollection({ base, schemaFields: flueFields }));

export const collections = {
  docs: section("docs"),
  guide: section("guide"),
  reference: section("reference"),
  cli: section("cli"),
  sdk: section("sdk"),
  ecosystem: section("ecosystem"),
  partials: defineCollection(partialsCollection()),
};
