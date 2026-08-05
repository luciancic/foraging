// Build-time content access for Astro pages, backed by the SQLite data layer
// (replaces the old astro:content collection). Plant guides render at build —
// they change through the agentic flow, and the nightly rebuild picks them up.
//
// Shapes each plant as { slug, data, bodyHtml } so page templates keep using the
// familiar `p.data.<field>` access; `bodyHtml` is the field-notes Markdown body
// rendered to HTML (the job astro:content's <Content /> used to do).
import MarkdownIt from 'markdown-it';
import { allPlants, getPlant } from './db.mjs';

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function shape(row) {
  const { body, ...data } = row;
  // `id` == the slug string, matching Astro's glob-collection convention the
  // rest of the codebase uses (p.id / params.slug).
  return { id: row.slug, data, bodyHtml: md.render(body || '') };
}

/** All plants, ordered by `order` then title — for the index + home lists. */
export function getPlants() {
  return allPlants().map(shape);
}

/** One plant by slug, or null. */
export function getPlantEntry(slug) {
  const row = getPlant(slug);
  return row ? shape(row) : null;
}
