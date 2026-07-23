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
