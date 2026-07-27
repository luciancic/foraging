import { defineCollection, z } from 'astro:content';

// One markdown file per plant in src/content/plants/.
// The body (markdown under the frontmatter) is free-form field notes:
// harvest, prep, recipes, links — write whatever you like there.
const plants = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    scientificName: z.string().optional(),
    commonNames: z.array(z.string()).default([]),
    // marker/category colour — mirrors the map categories
    category: z.enum(['tree', 'berries', 'greens', 'herbs', 'nuts', 'mushrooms', 'other']),
    // when it's usable
    season: z.string().optional(),
    // Fallback badge when no ripening window is given (e.g. year-round plants).
    // When ripeStart/ripeEnd ARE set, the badge is computed from today's date
    // instead — see src/lib/season.ts.
    status: z.enum(['ripe-now', 'coming-soon', 'note-for-next-year', 'year-round']).default('year-round'),
    // Ripening window as "MM-DD" (inclusive). If set, the live status is derived
    // from the current date, so the site stays correct as the season turns.
    ripeStart: z.string().regex(/^\d{2}-\d{2}$/).optional(),
    ripeEnd: z.string().regex(/^\d{2}-\d{2}$/).optional(),
    // lead photo (path under /public) + optional gallery
    heroImage: z.string().optional(),
    gallery: z.array(z.object({ src: z.string(), credit: z.string().optional(), caption: z.string().optional() })).default([]),
    // quick ID bullets
    idCues: z.array(z.string()).default([]),
    // safety / lookalike warnings — rendered prominently
    safety: z.array(z.string()).default([]),
    // external foraging guide links
    guides: z.array(z.object({ label: z.string(), url: z.string().url() })).default([]),
    // does a pin on the map correspond to this plant? (matched by species text)
    onMap: z.boolean().default(false),
    order: z.number().default(100),
    updated: z.string().optional(),
  }),
});

export const collections = { plants };
