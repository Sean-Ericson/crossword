/*
 * import-github.mjs — one-time move from the old GitHub data repo
 * (crossword-data) into the server's SQLite database.
 *
 *   node server/tools/import-github.mjs [--repo owner/name | --dir PATH]
 *        [--coop-profile co-op --coop-members sean,devon,kam]
 *        [--include-guest] [--dry-run]
 *
 * --repo  read through the GitHub API with the `gh` CLI (default
 *         Sean-Ericson/crossword-data); --dir reads a local clone instead.
 * --coop-profile / --coop-members
 *         a profile that was shared for solving together becomes co-op
 *         solves with these members, instead of an account of its own.
 *
 * For each users/<name>/: creates the account if missing (printing a
 * temporary password), imports progress/<yyyy>/<id>.json as the user's solo
 * solve (merged with anything already there, same rules as ever), and
 * stats.json into the solo solve log. Safe to re-run.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { loadConfig } from '../config.mjs';
import { Store, USER_NAME_RE } from '../db.mjs';
import { hashPassword } from '../auth.mjs';
import { Puzzles } from '../puzzles.mjs';
import { mergeProgress, recordFitsModel } from '../../js/state.js';

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

// ---------- sources ----------

function githubSource(repo) {
  const gh = (apiPath) => JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const tree = gh(`repos/${repo}/git/trees/HEAD?recursive=1`);
  if (tree.truncated) console.warn('WARNING: the repo listing was truncated; some files may be missed');
  const files = tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha }));
  return {
    list: () => files.map((f) => f.path),
    read: (p) => {
      const blob = gh(`repos/${repo}/git/blobs/${files.find((f) => f.path === p).sha}`);
      return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    },
  };
}

function dirSource(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      if (name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return {
    list: () => out,
    read: (p) => JSON.parse(readFileSync(path.join(dir, p), 'utf8')),
  };
}

// ---------- import ----------

async function main() {
  const cfg = loadConfig();
  const dryRun = has('--dry-run');
  const dir = arg('--dir');
  const repo = arg('--repo', 'Sean-Ericson/crossword-data');
  const coopProfile = arg('--coop-profile');
  const coopMembers = (arg('--coop-members') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (coopProfile && coopMembers.length < 2) {
    console.error('--coop-profile needs --coop-members with at least two names');
    process.exit(1);
  }
  if (dir && !existsSync(dir)) {
    console.error(`no such directory: ${dir}`);
    process.exit(1);
  }

  const source = dir ? dirSource(dir) : githubSource(repo);
  const store = new Store(path.join(cfg.dataDir, 'crossword.db'));
  const puzzles = new Puzzles(cfg, { log: {} });

  const byUser = new Map();
  for (const p of source.list()) {
    const m = /^users\/([^/]+)\/(.+)$/.exec(p);
    if (!m) continue;
    if (!byUser.has(m[1])) byUser.set(m[1], []);
    byUser.get(m[1]).push(m[2]);
  }

  const created = [];
  const ensureUser = (name, displayName) => {
    let user = store.userByName(name);
    if (!user && !dryRun) {
      const password = randomBytes(9).toString('base64url');
      user = store.createUser({ name, displayName: displayName || name, pwHash: hashPassword(password) });
      created.push([name, password]);
    }
    return user;
  };

  const totals = { solo: 0, coop: 0, solves: 0, skipped: 0 };
  for (const [name, files] of [...byUser].sort()) {
    if (!USER_NAME_RE.test(name)) {
      console.warn(`skipping users/${name}: not a valid account name`);
      continue;
    }
    if (name === 'guest' && !has('--include-guest')) {
      console.log('skipping users/guest (pass --include-guest to import it)');
      continue;
    }
    const isCoop = name === coopProfile;
    const profile = files.includes('profile.json') ? source.read(`users/${name}/profile.json`) : null;

    let owner = null;
    let memberIds = [];
    if (isCoop) {
      const members = coopMembers.map((n) => ensureUser(n));
      if (!dryRun && members.some((u) => !u)) throw new Error('could not resolve co-op members');
      memberIds = members.filter(Boolean).map((u) => u.id);
    } else {
      owner = ensureUser(name, profile?.display_name);
    }

    let solo = 0;
    let coop = 0;
    let skipped = 0;
    for (const f of files.filter((x) => x.startsWith('progress/') && x.endsWith('.json'))) {
      const record = source.read(`users/${name}/${f}`);
      const puzzleId = record?.puzzle_id || path.basename(f, '.json');
      const model = await puzzles.model(puzzleId);
      if (!model || !recordFitsModel(record, model)) {
        skipped++;
        continue;
      }
      if (dryRun) {
        isCoop ? coop++ : solo++;
        continue;
      }
      if (isCoop) {
        const sameMembers = (s) => [...s.members].sort().join() === [...coopMembers].sort().join();
        const exists = store.solvesForUser(memberIds[0], puzzleId).some((s) => s.kind === 'coop' && sameMembers(s));
        if (exists) continue;
        store.createSolve({ puzzleId, kind: 'coop', createdBy: memberIds[0], memberIds, record: { ...record, user: 'coop' } });
        coop++;
      } else {
        const incoming = { ...record, user: name };
        const existing = store.soloSolve(owner.id, puzzleId);
        if (!existing) {
          store.createSolve({ puzzleId, kind: 'solo', ownerId: owner.id, createdBy: owner.id, memberIds: [owner.id], record: incoming });
        } else {
          const winner = recordFitsModel(existing.record, model) ? mergeProgress(existing.record, incoming) : incoming;
          if (winner !== existing.record) store.saveRecord(existing.id, winner);
        }
        solo++;
      }
    }

    let solves = 0;
    if (!isCoop && files.includes('stats.json')) {
      const doc = source.read(`users/${name}/stats.json`);
      for (const [puzzleId, entry] of Object.entries(doc?.solves ?? {})) {
        if (!entry?.completed_at) continue;
        if (dryRun || store.recordSoloSolve(owner.id, puzzleId, entry)) solves++;
      }
    }
    totals.solo += solo;
    totals.coop += coop;
    totals.solves += solves;
    totals.skipped += skipped;
    console.log(
      `${name}${isCoop ? ` -> co-op (${coopMembers.join(', ')})` : ''}: ` +
        `${isCoop ? `${coop} co-op solves` : `${solo} puzzles, ${solves} solves logged`}` +
        (skipped ? `, ${skipped} skipped (puzzle not in archive)` : '')
    );
  }

  store.close();
  console.log(
    `\n${dryRun ? '[dry run] would import' : 'imported'} ${totals.solo} solo puzzles, ${totals.coop} co-op solves, ${totals.solves} logged solves` +
      (totals.skipped ? `; skipped ${totals.skipped}` : '')
  );
  if (created.length) {
    console.log('\nNew accounts (share these privately; they can change them after signing in):');
    for (const [name, pw] of created) console.log(`  ${name.padEnd(20)} ${pw}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
