import { userStmts } from '../lib/db.js';

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run user:delete -- <username>');
  process.exit(1);
}

const result = userStmts.delete.run(username);
if (result.changes === 0) {
  console.error(`User '${username}' not found.`);
  process.exit(1);
}
console.log(`Deleted user '${username}'.`);
