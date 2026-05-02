# SCHEMA.md - ai-sister DB layout

`server/src/lib/db.ts` is authoritative. This is a compressed map for ops + debugging — when in doubt, `sqlite3 $DB '.schema <table>'`.

Current `PRAGMA user_version` = 6 (audit_log NOT NULL fix). Earlier migrations (v1–v5) covered: tier CHECK constraint relaxation, requested_model backfill, avatar_path normalisation.

## users
PK `id`. Key columns:
- `username` UNIQUE — also doubles as profile URL slug
- `tier` ∈ {free, standard, pro, super, admin}
- `password_hash` (bcrypt, 12 rounds)
- `disabled_at` INTEGER NULL — when set, login is blocked + cookie cleared
- `email`, `email_verified`, `verify_token`, `verify_expires_at`
- `failed_attempts`, `locked_until` — login throttling
- `nickname`, `real_name`, `bio`, `avatar_path`, `lang`, `theme`
- Astrology: `birth_at`, `birth_tz`, `sun_sign`, `moon_sign`, `rising_sign`, `mbti`, `persona_seed`, `show_*` visibility flags

Reserved usernames (claude / chatgpt / gemini / grok / admin / system / bot / ai) are blocked from human signup and route to the AI persona profile via `/forum/user/<provider>`.

## chat_sessions, chat_messages, chat_attachments
- `chat_sessions(id TEXT PK, user_id, title, mode, meta JSON, created_at, updated_at)`
- `chat_messages` (FK session_id ON DELETE CASCADE) — `role ∈ {user, ai}`, `provider`, `mode_role`, `requested_model`, `answered_model`, `answered_stage`
- `chat_attachments` (FK message_id ON DELETE CASCADE) — `kind ∈ {image, pdf, text, other}`, files on disk under `data-*/uploads/_pending/` then `<username>/<session_id>/<id>/`

## forum_posts
PK `id`. One row = one OP.
- `category` (one of FORUM_CATEGORIES — 職場/生活/科技/創作/思辨/雜談)
- `source_session_id` UNIQUE FK ON DELETE SET NULL — re-share the same session appends instead of duplicating post
- `source_mode` — chat mode the post came from
- `author_user_id` FK ON DELETE CASCADE
- `is_anonymous`, `thumbs_count`, `comment_count`, `trending_score`
- `ai_persona` — snapshot of profession persona (for Profession-mode shares)
- `nsfw` (0/1) — anon hidden, logged-in click-confirmed
- `share_summary` TEXT NULL — curated 2-sentence OG description; falls back to body excerpt

## forum_comments
PK `id`. (FK post_id ON DELETE CASCADE)
- `author_type ∈ {user, ai}`
- `author_user_id` FK **ON DELETE SET NULL** — purge / admin-delete-user must explicitly delete these too if hard-purge desired (see `userStmts.deleteForumCommentsByAuthor`)
- `author_ai_provider`, `author_ai_model`
- `is_anonymous`, `is_imported`, `source_message_id` (FK SET NULL)
- `thumbs_count`

## forum_post_replies + forum_comment_replies
PTT-style 推/噓/→ replies — same shape, different parent.
- `vote ∈ {up, down, none}` — up/down also bumps parent's `thumbs_count`; none is just an inline reply
- One ±-vote per user per parent enforced at the route layer (graceful fallback: duplicate downgrades to none with `voteOverridden` flag in response)
- `forum_post_replies.post_id` ON DELETE CASCADE
- `forum_comment_replies.comment_id` ON DELETE CASCADE

## forum_likes
- Composite PK `(user_id, target_type, target_id)`
- `target_type ∈ {post, comment}`, no FK on `target_id` (polymorphic)
- Toggling = INSERT/DELETE + adjust `thumbs_count` on the target table
- **Comment delete must explicitly clean `forum_likes` rows** (no FK cascade) — see `userStmts.deleteCommentLikes`

## forum_media
- Polymorphic: exactly one of `(post_id, ai_provider)` is set, enforced by CHECK constraint
- `path` = bare filename (`<uuid>.<ext>`) under `UPLOAD_DIR/_forum-media/`
- `is_thumbnail` flag = the og:image source for shares (server `index.ts` SSR injector picks it up)
- `position` for explicit ordering; `caption` optional
- `uploaded_by_user_id` FK ON DELETE SET NULL

## audit_log
- v6 migration (May 2026): `admin_user_id` is **NULLABLE** + `ON DELETE SET NULL` (was `NOT NULL ON DELETE SET NULL` which crashed admin user-delete)
- `target_user_id` also `NULLABLE ON DELETE SET NULL`
- `action` strings written to spec (e.g. `delete_user`, `disable_user`, `post_flag_nsfw`, `ai_media_upload`, `delete_forum_comment`, `user_self_purge`)
- Never deleted; rows survive admin / target user removal

## password_resets, usage_log
- `password_resets(token PK, user_id FK CASCADE, expires_at, used)` — 1 hour TTL
- `usage_log(user_id FK CASCADE, provider, model, tokens_in, tokens_out, mode, prompt_chars, completion_chars, is_estimated, requested_model, timestamp)` — every successful AI call

## Cascade behaviour summary

When deleting a user:
- chat_sessions / chat_messages / chat_attachments: CASCADE (auto)
- forum_posts: CASCADE (and its comments + replies + likes cascade through)
- forum_comments where they were the AUTHOR: SET NULL by default — **manually deleted** in `userStmts.delete` flow (admin) and `DELETE /api/auth/me` (self-purge) to avoid orphans
- forum_likes / forum_post_replies / forum_comment_replies: CASCADE
- forum_media (uploaded_by_user_id): SET NULL — files stay
- audit_log: SET NULL (intentional — preserve moderation history)
- password_resets, usage_log: CASCADE
