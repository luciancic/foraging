// Date-driven foraging status. A plant with a ripening window (ripeStart/ripeEnd,
// "MM-DD") reports its status relative to *today*, so the site stays truthful as
// the season turns — no hardcoded "ripe now". Plants without a window fall back
// to their literal `status` (e.g. year-round tea/greens).
//
// The site is statically built, so "today" is the build date. A nightly rebuild
// timer (scripts/install.sh) keeps it fresh day to day.

export type Status = 'ripe-now' | 'coming-soon' | 'note-for-next-year' | 'year-round';

// How many days ahead of a window's start still counts as "coming soon".
const COMING_SOON_DAYS = 45;

type SeasonInput = { status: Status; ripeStart?: string; ripeEnd?: string };

function mmdd(s: string, year: number): Date {
  const [m, d] = s.split('-').map(Number);
  return new Date(year, m - 1, d);
}

const DAY = 86_400_000;

export function effectiveStatus(d: SeasonInput, now: Date = new Date()): Status {
  if (!d.ripeStart || !d.ripeEnd) return d.status;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const y = today.getFullYear();
  const start = mmdd(d.ripeStart, y);
  const end = mmdd(d.ripeEnd, y);

  // In-season (handles a window that wraps past Dec 31, though we don't use any).
  const inWindow = end >= start ? today >= start && today <= end : today >= start || today <= end;
  if (inWindow) return 'ripe-now';

  // Days until the next occurrence of the window's start.
  const pastThisYear = today > end && end >= start;
  const nextStart = pastThisYear ? mmdd(d.ripeStart, y + 1) : start >= today ? start : mmdd(d.ripeStart, y + 1);
  const days = Math.round((nextStart.getTime() - today.getTime()) / DAY);
  if (days > 0 && days <= COMING_SOON_DAYS) return 'coming-soon';

  return 'note-for-next-year';
}

export const STATUS_LABEL: Record<Status, string> = {
  'ripe-now': 'ripe now',
  'coming-soon': 'coming soon',
  'note-for-next-year': 'note for next year',
  'year-round': 'year-round',
};
