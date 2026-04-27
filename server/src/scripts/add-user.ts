import { hashPassword } from '../lib/auth.js';
import { userStmts } from '../lib/db.js';
import type { Tier } from '../shared/types.js';

function usage(): never {
  console.error('Usage: npm run user:add -- <username> <password> <standard|pro|super>');
  process.exit(1);
}

const [username, password, tierArg] = process.argv.slice(2);
if (!username || !password || !tierArg) usage();

const tier = tierArg as Tier;
if (tier !== 'standard' && tier !== 'pro' && tier !== 'super') usage();

const existing = userStmts.findByUsername.get(username);
if (existing) {
  console.error(`User '${username}' already exists. Use user:delete first or update tier directly.`);
  process.exit(1);
}

const hash = await hashPassword(password);
userStmts.insert.run(username, hash, tier);
console.log(`Created user '${username}' with tier '${tier}'.`);
