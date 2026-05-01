// LegalPage — terms / privacy. Public, no auth required. Mounted at
// /terms and /privacy. Content is intentionally written to be loose
// and operator-friendly: AS-IS service, broad latitude on suspending
// accounts, low liability cap, user takes responsibility for whatever
// they generate or share. Not legal advice; have a lawyer review
// before any meaningful enterprise contract.
//
// Content is bilingual via the same inline DICT pattern as LandingPage.
// Lang toggle in the header lets readers swap on the spot.

import React from 'react';
import type { Lang } from '../i18n';
import LangToggle from './LangToggle';

interface Props {
  kind: 'terms' | 'privacy';
  navigate: (path: string) => void;
  lang: Lang;
  onLangChange: (l: Lang) => void;
}

const COPY = {
  'zh-TW': {
    backToHome: '← 回首頁',
    lastUpdated: '最後更新日期：2026-04-30',
    contact: '如有疑問請聯絡：hello@ai-sister.com',
    terms: {
      title: '使用條款',
      intro:
        '歡迎使用 AI Sister（以下簡稱「本服務」、「我們」、「網站」）。當您註冊帳號或使用本網站時，視為您已閱讀、理解並同意下列條款。如不同意，請勿繼續使用。',
      sections: [
        {
          h: '1. 服務性質',
          p: 'AI Sister 是一個整合多家 AI 模型供應商（包含但不限於 Anthropic Claude、OpenAI ChatGPT、Google Gemini、xAI Grok）的對話平台。AI 回應由第三方模型即時生成，其準確性、完整性、時效性、無偏見性，**均不在我們的保證範圍內**。',
        },
        {
          h: '2. 使用者責任（重要）',
          p: '您對自己帳號的所有活動以及您於本服務產生、輸入、分享的所有內容（包含您與 AI 的對話內容、您發表到論壇的貼文與留言）**負完全責任**。具體包括：',
          list: [
            '不得利用本服務進行違法、騷擾、詐欺、誹謗、侵害他人權利、發布色情／暴力／仇恨內容、發送垃圾訊息，或試圖入侵或干擾本服務及其他使用者之帳號。',
            'AI 生成的內容**不構成醫療、法律、金融、心理或任何專業建議**。重大決策請諮詢相關領域的合格專業人士。',
            '若您將 AI 生成內容對外發布、轉載、商業使用或作為任何主張之依據，您須自行確認其合法性、正確性與風險，**並對由此產生的一切後果負責**。',
            '您應自行對重要對話、貼文、檔案備份；本服務不保證任何內容能永久保存。',
          ],
        },
        {
          h: '3. 帳號與內容授權',
          p: '您保留您所建立內容的智慧財產權，但當您將內容發布至本網站的公開區域（例如論壇）時，視為您授權我們以**非獨家、免授權金、全球性**之方式儲存、顯示、複製、改作（例如生成連結預覽圖）、與轉送該內容，以提供與宣傳本服務之用。本授權於您主動刪除該內容後合理時間內終止。',
        },
        {
          h: '4. 內容審核與帳號處置',
          p: '我們有權但無義務審核、保留、移除、拒絕顯示任何違反本條款或我們認為不適當之內容；亦得在**任何時間、無須事前通知或說明理由**之情況下，暫停、限制或終止您的帳號（包含但不限於違反本條款、長期未使用、技術原因、業務調整等）。',
        },
        {
          h: '5. 服務以「現況」提供',
          p: '本服務以「現況（as-is）」與「現有功能」提供，**不為任何特定目的、可用性、無錯誤、不中斷、安全性、無病毒、相容性，作明示或默示之保證**。我們得隨時新增、修改、暫停或終止任何功能，無須事前通知或補償。',
        },
        {
          h: '6. 免責與責任上限',
          p: '在法律允許的最大範圍內，我們對於您使用或無法使用本服務所引起或相關之**任何直接、間接、附帶、衍生、懲罰性損失**（包含但不限於：資料遺失、業務或利潤損失、AI 回應錯誤造成的決策損害、第三方索賠等）**不負任何賠償責任**。倘法律強制要求我們承擔，賠償總額以新台幣 100 元，或您於該事件發生前 12 個月內實際支付給我們的費用（取較低者）為上限。',
        },
        {
          h: '7. 第三方服務',
          p: '本服務為提供 AI 對話與基礎運作，會將您的訊息傳送給上述 AI 模型供應商及其他基礎設施服務商。各第三方有其各自之服務條款與隱私政策，**不在本條款規範範圍內**。',
        },
        {
          h: '8. 您對我們的補償義務',
          p: '若因您使用本服務、您發布的內容、或您違反本條款，導致我們、我們的關聯方或員工被任何第三方提出主張、訴訟、損失或費用，您同意以您自身費用**為我們抗辯並補償**該等損失。',
        },
        {
          h: '9. 條款修訂',
          p: '我們得隨時修訂本條款；修訂後的版本將公告於本頁面，自公告當日起生效。您持續使用本服務即視為同意修訂後的條款。',
        },
        {
          h: '10. 準據法與管轄',
          p: '本條款之解釋與適用，以及因本服務所生之一切爭議，**適用中華民國法律**，並以**臺灣臺北地方法院**為第一審專屬管轄法院。',
        },
      ],
    },
    privacy: {
      title: '隱私政策',
      intro:
        '我們重視您的個人資料保護。本政策說明我們收集、使用與保護資料的方式。使用本服務即視為您同意本政策。',
      sections: [
        {
          h: '1. 我們收集哪些資料',
          list: [
            '帳號資料：電子郵件、使用者名稱、密碼（以雜湊形式儲存）、語言偏好、頭像（選填）。',
            '對話與發文內容：您與 AI 的訊息、您在論壇上發表的貼文、留言、推噓紀錄。',
            '使用紀錄：登入時間、IP 位址、瀏覽器類型、操作日誌（用於除錯與防止濫用）。',
            'Cookies：用於維持登入狀態、語言偏好、最近瀏覽過的論壇貼文等基本功能。',
          ],
        },
        {
          h: '2. 我們如何使用資料',
          list: [
            '提供與維持服務（顯示對話、寄送驗證／密碼重設信件、產生 AI 回應）。',
            '改善服務品質、修復錯誤、偵測異常與防止濫用（例如重複帳號、垃圾訊息、攻擊行為）。',
            '在您主動將內容分享至論壇時，將其公開顯示給其他訪客。',
            '在符合法律規定下，回應主管機關的合法調查或司法請求。',
          ],
        },
        {
          h: '3. 第三方服務',
          p: '為了讓 AI 能回應您的訊息，我們會將您的對話內容傳送至第三方 AI 模型供應商（包含但不限於 Anthropic、OpenAI、Google、xAI）。我們**強烈建議您不要在對話中輸入高度敏感的個人資料**（例如完整身分證號、銀行卡號、醫療紀錄、密碼等）。我們同時使用下列基礎設施服務：Oracle Cloud（伺服器主機）、Resend（系統信件寄送）、Porkbun（網域與電郵轉寄）。各第三方有其各自之隱私政策。',
        },
        {
          h: '4. 我們不做的事',
          list: [
            '我們**不販售**您的個人資料給廣告商或資料經紀商。',
            '我們**不會**將您的對話內容用於訓練第三方公開模型（除前述為了回應您所必要的傳送外）。',
            '我們**不會**主動讀取您的私人對話用於業務目的，除非為了除錯特定問題並取得您的同意，或法律強制要求。',
          ],
        },
        {
          h: '5. 資料保留與刪除',
          p: '我們保留您的帳號資料直到您主動要求刪除，或帳號超過 24 個月未使用為止。寄送至 hello@ai-sister.com 的刪除請求我們將於合理時間內處理（通常 7 個工作天內）。請注意，已被其他使用者引用、轉貼、快取或備份的公開內容可能無法完全清除。',
        },
        {
          h: '6. 資料安全',
          p: '我們採取合理的技術與管理措施保護您的資料（包含密碼雜湊、TLS 加密傳輸、資料庫權限隔離等）。但**沒有任何網路服務能保證 100% 安全**。萬一發生資料外洩事件，我們將依適用法律盡速通知受影響的使用者。',
        },
        {
          h: '7. 兒童',
          p: '本服務**不針對 13 歲以下兒童**設計或提供。如您是未成年人，請在父母或監護人同意下使用。',
        },
        {
          h: '8. 國際傳輸',
          p: '由於我們使用的部分第三方服務位於其他國家或地區，您的資料可能會被傳送至中華民國以外處理。',
        },
        {
          h: '9. 政策修訂',
          p: '我們得隨時修訂本政策；修訂後的版本將公告於本頁面，自公告當日起生效。建議您定期查看以了解最新內容。',
        },
      ],
    },
  },
  en: {
    backToHome: '← Back to home',
    lastUpdated: 'Last updated: 2026-04-30',
    contact: 'Questions? Email hello@ai-sister.com',
    terms: {
      title: 'Terms of Service',
      intro:
        'Welcome to AI Sister ("the Service", "we", "our"). By creating an account or using this site, you agree to the terms below. If you do not agree, please stop using the Service.',
      sections: [
        {
          h: '1. What the Service is',
          p: 'AI Sister is a multi-AI conversation platform that integrates third-party language models including (but not limited to) Anthropic Claude, OpenAI ChatGPT, Google Gemini, and xAI Grok. AI responses are generated in real time by these third parties; we **do not warrant** their accuracy, completeness, timeliness, or freedom from bias.',
        },
        {
          h: '2. Your responsibilities (important)',
          p: 'You are **fully responsible** for all activity on your account and for everything you generate, input, or share through the Service — including your conversations with AI and anything you post to the forum. Specifically:',
          list: [
            "You may not use the Service for anything illegal, harassing, fraudulent, defamatory, infringing, sexually explicit, violent, hateful, or to spam, intrude on, or interfere with the Service or other users' accounts.",
            'AI-generated content **does not constitute medical, legal, financial, psychological, or any other professional advice**. For important decisions, consult a qualified professional.',
            'If you publish, repost, commercialise, or rely on AI-generated content, you are **solely responsible** for verifying its lawfulness, accuracy, and consequences.',
            'Back up anything important — we make no promise that any content remains available indefinitely.',
          ],
        },
        {
          h: '3. Your content and the licence to us',
          p: 'You retain intellectual-property rights in the content you create. By posting content to a public area of the Service (e.g. the forum), you grant us a **non-exclusive, royalty-free, worldwide** licence to store, display, copy, adapt (e.g. to generate link previews), and transmit that content for the purpose of providing and promoting the Service. The licence terminates within a reasonable time after you delete the content.',
        },
        {
          h: '4. Moderation & account actions',
          p: 'We may, but are not obligated to, review, retain, remove, or refuse to display any content that violates these terms or that we consider inappropriate. We may suspend, limit, or terminate your account **at any time, without prior notice or stated reason** (including but not limited to violation of these terms, prolonged inactivity, technical reasons, or business changes).',
        },
        {
          h: '5. Service provided "AS IS"',
          p: 'The Service is provided **as-is** and as-available, with **no warranties** of any kind, express or implied — including merchantability, fitness for a particular purpose, uninterrupted availability, error-free operation, security, virus-freeness, or compatibility. We may add, modify, suspend, or discontinue any feature at any time without notice or compensation.',
        },
        {
          h: '6. Limitation of liability',
          p: 'To the maximum extent permitted by law, we are **not liable for any direct, indirect, incidental, consequential, or punitive damages** arising out of or related to your use or inability to use the Service (including loss of data, business, or profits; harms caused by reliance on AI output; or third-party claims). If liability is mandated by law, our aggregate liability is capped at the **lesser of NT$100 (≈ US$3) or the fees you paid us in the 12 months preceding the event**.',
        },
        {
          h: '7. Third-party services',
          p: 'The Service forwards messages to third-party AI providers and other infrastructure vendors to function. Each of those parties operates under its own terms and privacy policies, **outside the scope of these terms**.',
        },
        {
          h: '8. Indemnification',
          p: 'You agree to **defend, indemnify, and hold us harmless** (and our affiliates and personnel) from any third-party claim, suit, loss, or expense arising from your use of the Service, your content, or your violation of these terms.',
        },
        {
          h: '9. Changes to these terms',
          p: 'We may update these terms at any time. The updated version will be posted on this page and is effective from the date of posting. Continued use of the Service constitutes acceptance.',
        },
        {
          h: '10. Governing law & venue',
          p: 'These terms are governed by the **laws of the Republic of China (Taiwan)**. Any dispute will be heard exclusively by the **Taipei District Court** as the court of first instance.',
        },
      ],
    },
    privacy: {
      title: 'Privacy Policy',
      intro:
        'We care about your privacy. This policy explains what we collect, how we use it, and how we protect it. By using the Service you consent to this policy.',
      sections: [
        {
          h: '1. What we collect',
          list: [
            'Account data: email, username, password (stored as a hash), language preference, optional avatar.',
            'Conversation & forum content: messages exchanged with the AIs, posts, comments, and votes you make in the forum.',
            'Usage logs: login times, IP address, browser type, server logs (for debugging and abuse prevention).',
            'Cookies: used for login state, language preference, and recent-forum-views.',
          ],
        },
        {
          h: '2. How we use it',
          list: [
            'To run the Service (display chats, send verification / password-reset emails, generate AI replies).',
            'To improve quality, fix bugs, detect anomalies, and prevent abuse (duplicate accounts, spam, attacks).',
            'When you choose to share content to the forum, we display it publicly to other visitors.',
            'To respond to lawful requests from authorities where required by applicable law.',
          ],
        },
        {
          h: '3. Third-party services',
          p: 'To produce AI responses we forward your messages to third-party AI providers including (but not limited to) Anthropic, OpenAI, Google, and xAI. **We strongly recommend you avoid sending highly sensitive personal data** (full national ID numbers, bank cards, medical records, passwords, etc.) through the Service. We also rely on Oracle Cloud (hosting), Resend (transactional email), and Porkbun (domain and email forwarding). Each operates under its own privacy policy.',
        },
        {
          h: '4. What we do NOT do',
          list: [
            'We **do not sell** your personal data to advertisers or data brokers.',
            'We **do not use** your conversations to train any third-party public model (beyond what is necessary to forward them for a reply).',
            'We **do not read** your private chats for business purposes unless required to debug a specific issue you have flagged or as compelled by law.',
          ],
        },
        {
          h: '5. Retention & deletion',
          p: 'We keep your account data until you ask us to delete it or your account is inactive for 24 months. Email deletion requests to hello@ai-sister.com; we typically process them within 7 business days. Note that public content cited, reposted, cached, or backed up by other users may not be fully removable.',
        },
        {
          h: '6. Security',
          p: 'We apply reasonable technical and organisational safeguards (password hashing, TLS in transit, database access controls). **No online service is 100% secure.** In the event of a data incident we will notify affected users as required by applicable law.',
        },
        {
          h: '7. Children',
          p: 'The Service is **not directed at children under 13**. If you are a minor, please use it with the consent of a parent or guardian.',
        },
        {
          h: '8. International transfers',
          p: 'Some of our third-party providers operate outside Taiwan, so your data may be transferred internationally for processing.',
        },
        {
          h: '9. Changes to this policy',
          p: 'We may update this policy at any time. The updated version will be posted here and is effective from posting. Please review periodically.',
        },
      ],
    },
  },
} as const;

interface Section {
  h: string;
  p?: string;
  list?: readonly string[];
}

export default function LegalPage({ kind, navigate, lang, onLangChange }: Props) {
  const c = COPY[lang];
  const page = c[kind];
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-30 bg-gray-950/85 backdrop-blur border-b border-gray-800">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button
            onClick={() => navigate('/')}
            className="text-sm font-bold text-white hover:text-pink-300"
          >
            {c.backToHome}
          </button>
          <LangToggle lang={lang} onChange={onLangChange} />
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-4 py-10 md:py-14">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-100 mb-3">
          {page.title}
        </h1>
        <p className="text-xs text-gray-500 mb-6">{c.lastUpdated}</p>
        <p className="text-sm md:text-base text-gray-300 leading-relaxed mb-8">
          {page.intro}
        </p>

        <div className="space-y-6">
          {(page.sections as readonly Section[]).map((s) => (
            <section key={s.h}>
              <h2 className="text-lg md:text-xl font-semibold text-gray-100 mb-2">
                {s.h}
              </h2>
              {s.p && (
                <p className="text-sm md:text-base text-gray-300 leading-relaxed mb-2 whitespace-pre-wrap">
                  {s.p}
                </p>
              )}
              {s.list && (
                <ul className="list-disc pl-5 space-y-1 text-sm md:text-base text-gray-300 leading-relaxed">
                  {s.list.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <p className="mt-10 pt-6 border-t border-gray-800 text-xs text-gray-500">
          {c.contact}
        </p>
      </article>
    </div>
  );
}
