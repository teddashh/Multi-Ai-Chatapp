// Centralized audit_log writes. Three categories live in the same table
// (so admin can see one chronological feed) but get split for display:
//
//   - admin   : an admin-tier user did something to another row
//               (invite_user, update_user, delete_user, view_session,
//               manual_digest_run, ...)
//   - model   : the orchestrator fell back to a different stage
//               (model_fallback)
//   - user    : a regular-tier user did something to themselves
//               (user_login_success, user_password_change, ...)
//
// Categorization is by action-name prefix:
//   'model_fallback'      → model
//   actions starting with 'user_'  → user
//   anything else                  → admin

import { auditStmts } from './db.js';

export type AuditCategory = 'admin' | 'model' | 'user';

export function categoryOf(action: string): AuditCategory {
  // Model Trail covers anything about model behavior — fallback chain
  // events plus background tasks like the auto-title NVIDIA call.
  if (action === 'model_fallback' || action === 'auto_title_fail') return 'model';
  if (action.startsWith('user_')) return 'user';
  return 'admin';
}

// Fire-and-forget audit write. Errors are logged but never rethrown —
// audit failures should never break a request.
export function logAudit(args: {
  // The actor — for admin actions this is the admin doing it; for
  // user_* actions this is the user doing it to themselves.
  actorUserId: number | null;
  // The row being acted on. For self-events (login, password change)
  // it's the same as actorUserId; for admin-on-user events it's the
  // user being acted on; for system events (model_fallback) it's the
  // user whose request triggered the fallback.
  targetUserId?: number | null;
  targetSessionId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}): void {
  if (args.actorUserId == null) return;
  try {
    auditStmts.insert.run(
      args.actorUserId,
      args.targetUserId ?? args.actorUserId,
      args.targetSessionId ?? null,
      args.action,
      args.metadata ? JSON.stringify(args.metadata) : null,
    );
  } catch (err) {
    console.error(`audit insert failed (${args.action})`, (err as Error).message);
  }
}
