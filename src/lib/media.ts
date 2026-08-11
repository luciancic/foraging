// Our own media (served by server/api.mjs from Storj under /images/plants/* and
// /photos/spots/*) supports on-the-fly resized WebP derivatives via ?v=thumb|card —
// so a 180px card or a popup thumbnail pulls ~20 KB instead of the full image.
// Only rewrite our own paths; leave any external/absolute URL untouched.
const LOCAL_MEDIA = /^\/(images\/plants|photos\/spots)\//;

export type MediaVariant = 'thumb' | 'card';

export const mediaVariant = (src: string, v: MediaVariant): string =>
  src && LOCAL_MEDIA.test(src) ? `${src}?v=${v}` : src;
