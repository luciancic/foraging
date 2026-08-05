// Build-time join: how many logged map spots link to a plant slug. Backed by the
// SQLite data layer (was the map GeoJSON file). A spot with `plant: <slug>` lights
// up that plant page's "on map" badge automatically — no manual flag to maintain.
// @ts-ignore — db.mjs is plain JS with no type declarations.
import { spotCountFor } from './db.mjs';

/** How many logged map spots link to this plant slug (0 = not on the map). */
export function spotCount(slug: string): number {
  return spotCountFor(slug);
}
