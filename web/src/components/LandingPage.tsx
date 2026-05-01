// LandingPage — public marketing surface mounted at `/`. Logged-in users
// auto-redirect to `/chat` (handled in App.tsx) so this page is mostly seen
// by first-time visitors and people clicking shared forum links from social.
//
// i18n strings live inline rather than in i18n.ts because they're scoped to
// this one file and not reused. If we ever localise to a third language,
// promote them upward then.

import React, { useEffect, useState } from 'react';
import { AI_BIOS, AI_PROVIDERS } from '../shared/constants';
import type { AIProvider } from '../shared/types';
import type { Lang } from '../i18n';
import {
  listForumPosts,
  type ForumPostSummary,
  type User,
} from '../api';
import LangToggle from './LangToggle';
import ProviderAvatar from './ProviderAvatar';

interface Props {
  navigate: (path: string) => void;
  lang: Lang;
  onLangChange: (l: Lang) => void;
  // Logged-in user (if any). When set, the top nav swaps the
  // login / signup CTAs for a "聊天室" pill that drops the user back
  // into the product.
  user: User | null;
}

interface LandingDict {
  navForum: string;
  navChat: string;
  navLogin: string;
  navSignup: string;
  heroTitle: string;
  heroTagline: string;
  heroDesc: string;
  ctaStart: string;
  ctaForum: string;
  featuresHeading: string;
  featuresSub: string;
  feat1Title: string;
  feat1Desc: string;
  feat2Title: string;
  feat2Desc: string;
  feat3Title: string;
  feat3Desc: string;
  feat4Title: string;
  feat4Desc: string;
  aiHeading: string;
  aiSub: string;
  aiCardCta: string;
  hotHeading: string;
  hotSub: string;
  hotEmpty: string;
  hotViewAll: string;
  finalHeading: string;
  finalDesc: string;
  finalCta: string;
  footerContact: string;
  footerForum: string;
  footerTerms: string;
  footerPrivacy: string;
  footerDataDeletion: string;
  footerCopyright: string;
}

const DICT: Record<Lang, LandingDict> = {
  'zh-TW': {
    navForum: '討論區',
    navChat: '聊天室',
    navLogin: '登入',
    navSignup: '免費註冊',
    heroTitle: 'AI 姐妹',
    heroTagline: '和 Claude、Gemini、Grok、ChatGPT 同桌對話',
    heroDesc:
      '一個對話框，四個 AI 同時回答。可以辯論、推理、扮演、諮詢專業意見，所有對話都能一鍵分享到公開論壇供大家討論。',
    ctaStart: '免費開始 →',
    ctaForum: '瀏覽論壇',
    featuresHeading: '為什麼一次跟四個 AI 對話',
    featuresSub: '單一 AI 容易給你它最像樣的版本。多個 AI 並排會讓你看到不同的觀點、推理路徑與盲點。',
    feat1Title: '多 AI 圓桌',
    feat1Desc:
      '同一個問題，四個 AI 同時作答。比較風格、補足遺漏，做決定更踏實。',
    feat2Title: '六種對話模式',
    feat2Desc:
      '自由聊、辯論、推理、角色扮演、職業諮詢、圓桌討論——同一個介面，依需要切換。',
    feat3Title: '分享到論壇',
    feat3Desc:
      '把任何一段對話轉貼到公開討論區，讓其他人推噓、留言、加入辯論。',
    feat4Title: '中英雙語免費',
    feat4Desc:
      '繁中／英文介面隨時切換，AI 回應完全跟隨你的語言設定。基本使用免費。',
    aiHeading: '四個 AI 各有特色',
    aiSub: '同一個問題，常常會得到四個截然不同的答案。點擊任一張卡片看完整檔案。',
    aiCardCta: '查看檔案 →',
    hotHeading: '熱門話題',
    hotSub: '看看大家最近在跟 AI 討論什麼。',
    hotEmpty: '還沒有熱門話題，成為第一個發文的人吧。',
    hotViewAll: '看全部討論 →',
    finalHeading: '準備好和四個 AI 一起想事情了嗎？',
    finalDesc: '註冊只要 30 秒，下一個你的對話就可以開始。',
    finalCta: '免費開始 →',
    footerContact: '聯絡',
    footerForum: '討論區',
    footerTerms: '使用條款',
    footerPrivacy: '隱私政策',
    footerDataDeletion: '資料刪除',
    footerCopyright: '© 2026 AI Sister · 由 Anthropic Claude、OpenAI、Google、xAI 提供模型',
  },
  en: {
    navForum: 'Forum',
    navChat: 'Chat',
    navLogin: 'Log in',
    navSignup: 'Sign up free',
    heroTitle: 'AI Sister',
    heroTagline: 'Talk to Claude, Gemini, Grok, and ChatGPT — together.',
    heroDesc:
      'One prompt, four answers. Debate, reason, role-play, or get a panel opinion. Share the conversations you find interesting to a public forum for others to weigh in.',
    ctaStart: 'Start free →',
    ctaForum: 'Browse forum',
    featuresHeading: 'Why talk to four AIs at once',
    featuresSub: 'A single model gives you its most polished take. Four side-by-side surface the disagreements, the missed angles, and the blind spots.',
    feat1Title: 'Four-way roundtable',
    feat1Desc: 'Same question, four answers. Compare styles, fill in gaps, decide with more confidence.',
    feat2Title: 'Six conversation modes',
    feat2Desc: 'Free chat, debate, reasoning, role-play, profession panel, roundtable — switch at will.',
    feat3Title: 'Forum sharing',
    feat3Desc: 'Promote any chat to a public thread where others can upvote, downvote, and join the discussion.',
    feat4Title: 'Bilingual & free',
    feat4Desc: 'Toggle between Traditional Chinese and English. AI replies match your UI language. Free to use.',
    aiHeading: 'Four AIs, four personalities',
    aiSub: 'You often get four different answers — which is the whole point. Click any card to read its profile.',
    aiCardCta: 'View profile →',
    hotHeading: 'Hot topics',
    hotSub: "See what people are debating with the AIs right now.",
    hotEmpty: 'No trending posts yet — be the first to share a conversation.',
    hotViewAll: 'See all discussions →',
    finalHeading: 'Ready to think with four AIs?',
    finalDesc: 'Sign-up takes 30 seconds. Your next conversation is one click away.',
    finalCta: 'Start free →',
    footerContact: 'Contact',
    footerForum: 'Forum',
    footerTerms: 'Terms',
    footerPrivacy: 'Privacy',
    footerDataDeletion: 'Data deletion',
    footerCopyright: '© 2026 AI Sister · Powered by Anthropic Claude, OpenAI, Google, xAI',
  },
};

export default function LandingPage({ navigate, lang, onLangChange, user }: Props) {
  const t = DICT[lang];
  const goChat = () => navigate('/chat');
  const goForum = () => navigate('/forum');
  const features = [
    { title: t.feat1Title, desc: t.feat1Desc },
    { title: t.feat2Title, desc: t.feat2Desc },
    { title: t.feat3Title, desc: t.feat3Desc },
    { title: t.feat4Title, desc: t.feat4Desc },
  ];
  const providers: AIProvider[] = ['claude', 'gemini', 'grok', 'chatgpt'];

  // Trending posts strip — fetched once on mount. Failures fall through
  // to an empty list (covered by hotEmpty copy); we don't surface errors
  // on a marketing page.
  const [hotPosts, setHotPosts] = useState<ForumPostSummary[] | null>(null);
  useEffect(() => {
    listForumPosts({ sort: 'trending', limit: 6 })
      .then((r) => setHotPosts(r.posts))
      .catch(() => setHotPosts([]));
  }, []);

  return (
    <div className="min-h-screen text-gray-100">
      {/* Top nav — minimal, doesn't reuse the in-app TopNav because that
          one is dense with login/profile/admin controls that don't belong
          on a marketing page. */}
      <header className="sticky top-0 z-30 bg-gray-950/85 backdrop-blur border-b border-gray-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <button
            onClick={() => navigate('/')}
            className="text-base md:text-lg font-bold text-white hover:text-pink-300 transition-colors"
          >
            AI Sister / AI 姐妹
          </button>
          <nav className="flex items-center gap-1 md:gap-2 text-xs md:text-sm">
            <button
              onClick={goForum}
              className="px-2 md:px-3 py-1.5 rounded text-gray-300 hover:bg-gray-800 hover:text-white"
            >
              {t.navForum}
            </button>
            <LangToggle lang={lang} onChange={onLangChange} />
            {user ? (
              <button
                onClick={goChat}
                className="px-3 md:px-4 py-1.5 rounded-full bg-pink-500 hover:bg-pink-400 text-white font-medium"
              >
                {t.navChat} →
              </button>
            ) : (
              <>
                <button
                  onClick={goChat}
                  className="px-2 md:px-3 py-1.5 rounded text-gray-300 hover:bg-gray-800 hover:text-white"
                >
                  {t.navLogin}
                </button>
                <button
                  onClick={goChat}
                  className="px-3 md:px-4 py-1.5 rounded-full bg-pink-500 hover:bg-pink-400 text-white font-medium"
                >
                  {t.navSignup}
                </button>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="px-4 pt-16 pb-12 md:pt-24 md:pb-16">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl md:text-6xl font-bold leading-tight bg-gradient-to-r from-pink-500 via-purple-500 to-pink-600 bg-clip-text text-transparent">
            {t.heroTitle}
          </h1>
          <p className="mt-5 text-lg md:text-2xl text-gray-200 font-medium">
            {t.heroTagline}
          </p>
          <p className="mt-4 max-w-2xl mx-auto text-sm md:text-base text-gray-400 leading-relaxed">
            {t.heroDesc}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row justify-center gap-3">
            <button
              onClick={goChat}
              className="px-6 py-3 rounded-full bg-pink-500 hover:bg-pink-400 text-white font-semibold transition-colors text-base"
            >
              {t.ctaStart}
            </button>
            <button
              onClick={goForum}
              className="px-6 py-3 rounded-full bg-gray-800 hover:bg-gray-700 text-gray-200 font-semibold border border-gray-700 transition-colors text-base"
            >
              {t.ctaForum}
            </button>
          </div>
          {/* Provider mini-strip — visual proof of "four AIs" without
              dragging the heavy AICard rows up here. */}
          <div className="mt-10 flex justify-center items-center gap-4 md:gap-6 text-xs text-gray-500">
            {providers.map((p) => (
              <div key={p} className="flex items-center gap-2">
                <ProviderAvatar provider={p} size={28} />
                <span className="hidden sm:inline">{AI_PROVIDERS[p].name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features — kept compact and icon-less. Four short stanzas in a
          horizontal row read as a punchy summary instead of cluttering
          the page with placeholder emoji "icons". */}
      <section className="px-4 py-10 border-t border-gray-200/40">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-7">
            <h2 className="text-xl md:text-2xl font-bold text-gray-100">
              {t.featuresHeading}
            </h2>
            <p className="mt-2 max-w-2xl mx-auto text-xs md:text-sm text-gray-400">
              {t.featuresSub}
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5">
            {features.map((f) => (
              <div key={f.title}>
                <h3 className="text-sm font-semibold text-gray-100 mb-1">
                  {f.title}
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI characters */}
      <section className="px-4 py-12 md:py-16 border-t border-gray-200/40">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-2xl md:text-3xl font-bold text-gray-100">
              {t.aiHeading}
            </h2>
            <p className="mt-3 text-sm md:text-base text-gray-400">{t.aiSub}</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {providers.map((p) => (
              <button
                key={p}
                onClick={() => navigate(`/forum/user/${p}`)}
                className="group text-left rounded-xl border border-gray-800 bg-gray-900/60 p-5 hover:border-pink-400/60 hover:bg-gray-900 transition-all flex flex-col items-center text-center cursor-pointer"
              >
                <ProviderAvatar provider={p} size={56} />
                <h3 className="mt-3 text-base font-semibold text-gray-100 group-hover:text-pink-200">
                  {AI_PROVIDERS[p].name}
                </h3>
                <p className="mt-1 text-xs" style={{ color: AI_PROVIDERS[p].color }}>
                  {AI_BIOS[p].tagline}
                </p>
                <p className="mt-3 text-xs text-gray-400 leading-relaxed">
                  {AI_BIOS[p].bio}
                </p>
                <span className="mt-3 text-[11px] text-pink-300/0 group-hover:text-pink-300 transition-colors">
                  {t.aiCardCta}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Hot topics — proves the product is alive + drives traffic to
          /forum which carries our SEO weight. Empty state shown when
          the API returns no posts (or fails). */}
      <section className="px-4 py-12 md:py-16 border-t border-gray-900">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-2xl md:text-3xl font-bold text-gray-100">
              {t.hotHeading}
            </h2>
            <p className="mt-3 text-sm md:text-base text-gray-400">{t.hotSub}</p>
          </div>
          {hotPosts === null ? (
            <div className="text-center text-sm text-gray-500 py-6">…</div>
          ) : hotPosts.length === 0 ? (
            <div className="text-center text-sm text-gray-500 py-6">
              {t.hotEmpty}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {hotPosts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => navigate(`/forum/post/${p.id}`)}
                  className="text-left rounded-lg border border-gray-800 bg-gray-900/60 p-4 hover:border-pink-400/60 hover:bg-gray-900 transition-all"
                >
                  <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-1.5">
                    <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                      {p.category}
                    </span>
                    {p.nsfw && (
                      <span
                        className="px-1.5 py-0.5 rounded bg-red-900/50 text-red-200 border border-red-700/40 font-semibold"
                        title="18+ 內容"
                      >
                        🔞 18+
                      </span>
                    )}
                    <span>·</span>
                    <span className="truncate">{p.authorDisplay}</span>
                  </div>
                  <h3 className="text-sm font-semibold text-gray-100 line-clamp-2 leading-snug">
                    {p.title}
                  </h3>
                  <p className="mt-1.5 text-xs text-gray-400 line-clamp-2 leading-relaxed">
                    {p.bodyPreview}
                  </p>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-500">
                    <span>❤ {p.thumbsCount}</span>
                    <span>💬 {p.commentCount}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="text-center mt-6">
            <button
              onClick={goForum}
              className="text-sm text-pink-300 hover:text-pink-200"
            >
              {t.hotViewAll}
            </button>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-4 py-16 md:py-20 border-t border-gray-900">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-100">
            {t.finalHeading}
          </h2>
          <p className="mt-3 text-sm md:text-base text-gray-400">{t.finalDesc}</p>
          <button
            onClick={goChat}
            className="mt-6 px-7 py-3 rounded-full bg-pink-500 hover:bg-pink-400 text-white font-semibold text-base transition-colors"
          >
            {t.finalCta}
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-4 py-8 border-t border-gray-900 text-xs text-gray-500">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <span>{t.footerCopyright}</span>
          <div className="flex items-center gap-4 flex-wrap">
            <button onClick={goForum} className="hover:text-white">
              {t.footerForum}
            </button>
            <button
              onClick={() => navigate('/terms')}
              className="hover:text-white"
            >
              {t.footerTerms}
            </button>
            <button
              onClick={() => navigate('/privacy')}
              className="hover:text-white"
            >
              {t.footerPrivacy}
            </button>
            <button
              onClick={() => navigate('/data-deletion')}
              className="hover:text-white"
            >
              {t.footerDataDeletion}
            </button>
            <a href="mailto:hello@ai-sister.com" className="hover:text-white">
              {t.footerContact}: hello@ai-sister.com
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
