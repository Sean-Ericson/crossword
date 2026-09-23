/*
 * admin.mjs — account management from the server's command line.
 *
 *   node server/admin.mjs list
 *   node server/admin.mjs add-user <name> [--display "Name"] [--admin] [--password PW]
 *   node server/admin.mjs reset-password <name> [--password PW]
 *   node server/admin.mjs set-admin <name> on|off
 *   node server/admin.mjs delete-user <name>
 *
 * Without --password a random temporary password is generated and
 * printed; people change it from their account menu after logging in.
 * Safe to run while the server is up (SQLite handles the locking).
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { Store } from './db.mjs';
import { hashPassword, validatePassword } from './auth.mjs';

function usage(msg) {
  if (msg) console.error(msg + '\n');
  console.error(`usage:
  node server/admin.mjs list
  node server/admin.mjs add-user <name> [--display "Name"] [--admin] [--password PW]
  node server/admin.mjs reset-password <name> [--password PW]
  node server/admin.mjs set-admin <name> on|off
  node server/admin.mjs delete-user <name>`);
  process.exit(1);
}

function option(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function tempPassword() {
  // 4 groups of 4 unambiguous chars: easy to read out, ~80 bits
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

function passwordFrom(args) {
  const given = option(args, '--password');
  if (given !== undefined) {
    const problem = validatePassword(given);
    if (problem) usage(problem);
    return { password: given, generated: false };
  }
  return { password: tempPassword(), generated: true };
}

export function runAdmin(argv, store) {
  const [cmd, name, ...rest] = argv;
  switch (cmd) {
    case 'list': {
      const users = store.listUsers();
      if (!users.length) console.log('(no users yet)');
      for (const u of users) {
        console.log(`${u.name.padEnd(24)} ${u.display_name.padEnd(20)} ${u.color}${u.is_admin ? '  admin' : ''}`);
      }
      return;
    }
    case 'add-user': {
      if (!name) usage('add-user needs a name');
      if (store.userByName(name)) usage(`“${name}” already exists`);
      const { password, generated } = passwordFrom(rest);
      const user = store.createUser({
        name,
        displayName: option(rest, '--display') ?? name,
        pwHash: hashPassword(password),
        isAdmin: rest.includes('--admin'),
      });
      console.log(`created ${user.name}${user.is_admin ? ' (admin)' : ''}`);
      if (generated) console.log(`temporary password: ${password}`);
      return;
    }
    case 'reset-password': {
      const user = store.userByName(name || '');
      if (!user) usage(`no user “${name}”`);
      const { password, generated } = passwordFrom(rest);
      store.setPassword(user.id, hashPassword(password));
      console.log(`password reset for ${user.name}; their other sessions were signed out`);
      if (generated) console.log(`temporary password: ${password}`);
      return;
    }
    case 'set-admin': {
      const user = store.userByName(name || '');
      if (!user) usage(`no user “${name}”`);
      const on = rest[0] === 'on';
      store.updateUser(user.id, { isAdmin: on });
      console.log(`${user.name} is ${on ? 'now' : 'no longer'} an admin`);
      return;
    }
    case 'delete-user': {
      const user = store.userByName(name || '');
      if (!user) usage(`no user “${name}”`);
      store.deleteUser(user.id);
      console.log(`deleted ${user.name} and their solo progress`);
      return;
    }
    default:
      usage(cmd ? `unknown command “${cmd}”` : '');
  }
}

if (import.meta.url.endsWith(path.basename(process.argv[1] || ''))) {
  const cfg = loadConfig();
  const store = new Store(path.join(cfg.dataDir, 'crossword.db'));
  try {
    runAdmin(process.argv.slice(2), store);
  } finally {
    store.close();
  }
}
