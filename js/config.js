/*
 * config.js — site-wide constants shared by the pages.
 */

/**
 * How far back each puzzle type goes at NYT (probed against the archive).
 * Days at or after these dates are offered for on-demand fetching even if
 * they aren't downloaded yet; earlier days are shown as unavailable.
 * Gaps within a range are fine - a fetch that finds nothing reports back.
 */
export const ARCHIVE_START = {
  daily: '1993-11-21', // start of the Shortz era
  mini: '2013-10-12', // sporadic until Aug 2014, then daily
  midi: '2026-03-02',
  bonus: '1997-02-01', // monthly
};
