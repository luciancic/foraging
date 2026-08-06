// Build-time join: how many map pins link to a plant slug. Backed by the unified
// SQLite `pins` table — confirmed spots and scouting leads are both rows there, so
// a plant's "on map" counts come from ONE explicit `WHERE plant = slug` query
// instead of a COUNT over spots plus a keyword scan of the lead GeoJSON.
// @ts-ignore — db.mjs is plain JS with no type declarations.
import { pinCountsFor } from './db.mjs';

/** Confirmed spots + unverified leads linked to this plant slug. */
export function pinCounts(slug: string): { confirmed: number; leads: number } {
  return pinCountsFor(slug);
}

/** Confirmed logged spots for this plant (0 = not on the map). */
export function spotCount(slug: string): number {
  return pinCountsFor(slug).confirmed;
}

/** Unverified scouting leads referencing this plant. */
export function leadCount(slug: string): number {
  return pinCountsFor(slug).leads;
}
