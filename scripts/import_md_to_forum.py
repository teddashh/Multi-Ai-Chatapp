#!/usr/bin/env python3
"""
Import legacy Multi-AI Chat browser-extension exports (.md) into the forum
DB as forum_posts + forum_comments. The MD format is fixed:

    # Multi-AI Chat — 🔄 道理辯證
    > Exported: 4/25/2026, 2:22:06 AM

    ---

    ## 👤 User
    > body line
    > body line

    ---

    ## 🤖 Claude (第1輪)

    ai reply text

    ---

    ## 🤖 Gemini (第1輪)
    ...

The first 👤 User block becomes the post body. Every 🤖 block becomes a
forum_comments row tied to the post, in chronological order, with
author_ai_provider derived from the heading. Posts are author_user_id =
the configured admin user (Ted), is_anonymous = 0, source_session_id =
NULL (no chat-session backing — these are imports), source_mode =
'roundtable'.

Usage:
    python3 import_md_to_forum.py --db PATH --user-id 1 --dry-run
    python3 import_md_to_forum.py --db PATH --user-id 1 --commit
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

PROVIDER_HEADING_TO_ID = {
    'Claude': 'claude',
    'ChatGPT': 'chatgpt',
    'Gemini': 'gemini',
    'Grok': 'grok',
}

# Hand-written titles + categories per file. Browser-extension exports
# don't carry forum-ready titles; the user asked us to write them.
IMPORTS = [
    {
        'file': 'multi-ai-chat-roundtable-2026-04-20-02-55-54.md',
        'title': '命理系統的時間序列預測：怎麼設計可證偽的研究？',
        'category': '思辨',
        'exported_at': '2026-04-19 22:55:54',
    },
    {
        'file': 'multi-ai-chat-roundtable-2026-04-24-20-35-46.md',
        'title': 'Odoo MCP 適合當 Agent OS 的核心嗎？4 AI 圓桌',
        'category': '科技',
        'exported_at': '2026-04-24 16:35:46',
    },
    {
        'file': 'multi-ai-chat-roundtable-2026-04-25-06-22-06.md',
        'title': '為什麼還有人用 BB 槍搶銀行？4 AI 拆解絕望、賭徒邏輯、犯罪市場',
        'category': '思辨',
        'exported_at': '2026-04-25 02:22:06',
    },
]

SECTION_RE = re.compile(r'(?m)^## ')


def _strip_blockquote(body: str) -> str:
    """Strip leading `> ` markdown blockquote markers from each line so
    the message reads as prose in the forum, not a quoted reply."""
    cleaned = []
    for ln in body.split('\n'):
        if ln.startswith('> '):
            cleaned.append(ln[2:])
        elif ln.startswith('>'):
            cleaned.append(ln[1:].lstrip())
        else:
            cleaned.append(ln)
    return '\n'.join(cleaned).strip()


def parse_md(path: Path) -> tuple[str, list[tuple[str, str]]]:
    """Return (post_body, [(kind, body), ...]).

    `kind` is one of {'user', 'claude', 'chatgpt', 'gemini', 'grok'}.
    Multi-turn conversations are flattened — the FIRST 👤 block becomes
    the post body, every later 👤 / 🤖 block becomes a chronological
    comment so the entire roundtable thread is preserved.
    """
    text = path.read_text(encoding='utf-8')

    parts = SECTION_RE.split(text)
    sections = parts[1:]
    post_body: str | None = None
    msgs: list[tuple[str, str]] = []

    for sec in sections:
        heading, _, body = sec.partition('\n')
        body = body.strip()
        body = re.sub(r'\n*---\s*$', '', body).strip()
        body = re.sub(r'\n{3,}', '\n\n', body)
        heading = heading.strip()

        if heading.startswith('👤'):
            cleaned = _strip_blockquote(body)
            if post_body is None:
                post_body = cleaned
            else:
                msgs.append(('user', cleaned))
            continue

        if heading.startswith('🤖'):
            m = re.match(r'🤖\s+(\w+)', heading)
            if not m:
                continue
            name = m.group(1)
            provider = PROVIDER_HEADING_TO_ID.get(name)
            if not provider:
                print(f'  ! unknown AI heading: {heading}', file=sys.stderr)
                continue
            msgs.append((provider, body))

    if post_body is None:
        raise RuntimeError(f'no 👤 User block found in {path}')
    return post_body, msgs


def epoch_seconds(iso: str) -> int:
    return int(datetime.strptime(iso, '%Y-%m-%d %H:%M:%S').timestamp())


def import_one(
    conn: sqlite3.Connection,
    user_id: int,
    md_path: Path,
    title: str,
    category: str,
    exported_at: str,
    dry_run: bool,
) -> None:
    post_body, msgs = parse_md(md_path)
    counts = {'user': 0, 'claude': 0, 'chatgpt': 0, 'gemini': 0, 'grok': 0}
    for kind, _ in msgs:
        counts[kind] = counts.get(kind, 0) + 1
    print(f'\n=== {md_path.name} ===')
    print(f'  title: {title}')
    print(f'  category: {category}')
    print(
        f'  post body: {len(post_body)} chars, '
        f'{post_body.count(chr(10)) + 1} lines'
    )
    print(
        f'  comments: {len(msgs)}  '
        f'(user={counts["user"]}, claude={counts["claude"]}, '
        f'chatgpt={counts["chatgpt"]}, gemini={counts["gemini"]}, '
        f'grok={counts["grok"]})'
    )

    if dry_run:
        return

    post_ts = epoch_seconds(exported_at)
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO forum_posts
           (category, source_session_id, source_mode, title, body,
            author_user_id, is_anonymous, comment_count, ai_persona,
            created_at, updated_at)
           VALUES (?, NULL, 'roundtable', ?, ?, ?, 0, ?, NULL, ?, ?)""",
        (category, title, post_body, user_id, len(msgs), post_ts, post_ts),
    )
    post_id = cur.lastrowid
    # Each turn bumps the timestamp by 1s so chronological order is
    # preserved when the forum sorts by created_at.
    for i, (kind, body) in enumerate(msgs):
        ts = post_ts + i + 1
        if kind == 'user':
            cur.execute(
                """INSERT INTO forum_comments
                   (post_id, author_type, author_user_id,
                    author_ai_provider, author_ai_model, body,
                    is_anonymous, is_imported, source_message_id,
                    created_at)
                   VALUES (?, 'user', ?, NULL, NULL, ?, 0, 1, NULL, ?)""",
                (post_id, user_id, body, ts),
            )
        else:
            cur.execute(
                """INSERT INTO forum_comments
                   (post_id, author_type, author_user_id,
                    author_ai_provider, author_ai_model, body,
                    is_anonymous, is_imported, source_message_id,
                    created_at)
                   VALUES (?, 'ai', NULL, ?, NULL, ?, 0, 1, NULL, ?)""",
                (post_id, kind, body, ts),
            )
    conn.commit()
    print(f'  → inserted post id={post_id} with {len(msgs)} comments')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True, help='Path to app.db')
    ap.add_argument('--user-id', type=int, required=True, help='Author user_id')
    ap.add_argument('--md-dir', required=True, help='Directory with the .md files')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dry-run', action='store_true')
    g.add_argument('--commit', action='store_true')
    args = ap.parse_args()

    md_dir = Path(args.md_dir)
    if not md_dir.is_dir():
        print(f'md-dir not found: {md_dir}', file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)
    conn.execute('PRAGMA foreign_keys = ON')

    for spec in IMPORTS:
        path = md_dir / spec['file']
        if not path.exists():
            print(f'! missing: {path}', file=sys.stderr)
            continue
        import_one(
            conn,
            user_id=args.user_id,
            md_path=path,
            title=spec['title'],
            category=spec['category'],
            exported_at=spec['exported_at'],
            dry_run=args.dry_run,
        )

    if args.dry_run:
        print('\n(dry-run; no DB changes)')
    else:
        print('\nDone.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
