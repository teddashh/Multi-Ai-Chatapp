import { userStmts } from '../lib/db.js';

const rows = userStmts.list.all() as Array<{
  id: number;
  username: string;
  tier: string;
  created_at: number;
}>;

if (rows.length === 0) {
  console.log('(no users)');
} else {
  console.log('id  tier      username           created');
  console.log('--  --------  -----------------  -------------------');
  for (const r of rows) {
    const created = new Date(r.created_at * 1000).toISOString().slice(0, 19).replace('T', ' ');
    console.log(
      `${String(r.id).padEnd(2)}  ${r.tier.padEnd(8)}  ${r.username.padEnd(17)}  ${created}`,
    );
  }
}
