/*
 * config.js — site-wide defaults.
 *
 * The GitHub data-repo settings below are only defaults for the settings
 * panel; whatever the user saves there (localStorage `xw:site:gh`) wins.
 * Fill in `owner` with your GitHub username before deploying so family
 * members only have to paste a token.
 */

export const SITE_CONFIG = {
  siteTitle: 'The Crossword',
  data: {
    owner: 'Sean-Ericson',
    repo: 'crossword-data',
    branch: 'main',
  },
};

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

/** On-demand fetching: how long to wait before suggesting something's wrong. */
export const FETCH_POLL_MS = 4000;
export const FETCH_TIMEOUT_MS = 6 * 60 * 1000;
