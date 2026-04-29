import { createContext, useContext } from 'react';
import type { ChatMode } from './shared/types';

export type Lang = 'zh-TW' | 'en';

// Every key listed here MUST exist in both dictionaries — TS keeps us honest.
export interface Dict {
  // App-wide
  appName: string;
  loading: string;
  cancel: string;
  save: string;
  delete: string;
  rename: string;
  close: string;
  send: string;
  stop: string;
  uploading: string;
  remove: string;
  loginNeeded: string;
  passwordTooShort: string;
  passwordsDontMatch: string;

  // Header
  logout: string;
  manageUsers: string;
  profile: string;
  langZh: string;
  langEn: string;

  // Login
  loginTitle: string;
  loginUsernameLabel: string;
  loginPasswordLabel: string;
  loginForgot: string;
  loginSigningIn: string;
  loginSignIn: string;
  loginNoAccount: string;
  loginHaveAccount: string;
  signupTitle: string;
  signupEmail: string;
  signupPassword: string;
  signupNickname: string;
  signupSubmit: string;
  signupSubmitting: string;
  signupTierNote: string;
  signupUsername: string;
  signupUsernamePlaceholder: string;
  signupUsernameHint: string;
  resetUsernameLabel: string;
  resetUsernameHint: string;
  resetWelcomeInvite: string;
  profileUsername: string;
  verifyBannerText: string;
  verifyBannerResend: string;
  verifyBannerSent: string;
  verifySuccess: string;
  verifyFailed: (msg: string) => string;
  verifyVerifying: string;
  connectionLostBanner: string;
  connectionLostDismiss: string;
  forgotTitle: string;
  forgotPrompt: string;
  forgotSent: string;
  forgotPlaceholder: string;
  forgotSend: string;
  forgotBack: string;

  // Reset password
  resetTitle: string;
  resetNewLabel: string;
  resetConfirmLabel: string;
  resetSubmit: string;
  resetting: string;
  resetSuccess: string;
  resetBackLogin: string;

  // Sidebar
  sidebarNew: string;
  sidebarEmpty: string;
  sidebarExport: string;
  sidebarRename: string;
  sidebarDelete: string;
  sidebarConfirmDelete: string;
  sidebarOpen: string;
  timeJustNow: string;
  timeMinAgo: (n: number) => string;
  timeHourAgo: (n: number) => string;
  timeDayAgo: (n: number) => string;

  // Chat / modes
  modeFreeName: string;
  modeFreeDesc: string;
  modeDebateName: string;
  modeDebateDesc: string;
  modeConsultName: string;
  modeConsultDesc: string;
  modeCodingName: string;
  modeCodingDesc: string;
  modeRoundtableName: string;
  modeRoundtableDesc: string;

  modeFreeHowto1: string;
  modeFreeHowto2: string;
  modeDebateHowto1: string;
  modeDebateHowto2: string;
  modeConsultHowto1: string;
  modeConsultHowto2: string;
  modeCodingHowto1: string;
  modeCodingHowto2: string;
  modeRoundtableHowto1: string;
  modeRoundtableHowto2: string;
  modeRoundtableHowto3: string;

  chatStartHere: string;
  chatExpand: string;
  chatCollapse: string;
  retryFreeIdle: string;
  retryFreeBusy: string;
  retrySeqIdle: string;
  retrySeqBusy: string;
  retryFreeTitle: string;
  retrySeqTitle: string;
  retryFailed: (msg: string) => string;
  msgCopy: string;
  msgCopied: string;
  msgExportTablesCsv: (n: number) => string;
  msgExportTablesXlsx: (n: number) => string;
  msgExportPdf: string;
  msgNoTables: string;
  loadFailed: (msg: string) => string;
  exportFailed: (msg: string) => string;
  deleteFailed: (msg: string) => string;
  renameFailed: (msg: string) => string;

  // Role config labels (per mode)
  roleDebatePro: string;
  roleDebateCon: string;
  roleDebateJudge: string;
  roleDebateSummary: string;
  roleConsultFirst: string;
  roleConsultSecond: string;
  roleConsultReviewer: string;
  roleConsultSummary: string;
  roleCodingPlanner: string;
  roleCodingReviewer: string;
  roleCodingCoder: string;
  roleCodingTester: string;
  roleRoundtable1: string;
  roleRoundtable2: string;
  roleRoundtable3: string;
  roleRoundtable4: string;
  roleConfigShow: string;
  roleConfigHide: string;

  // InputBar
  inputPlaceholderIdle: string;
  inputPlaceholderProcessing: string;
  inputAttachTitle: (count: number, max: number) => string;
  inputFileTooLarge: (name: string, mb: number) => string;

  // Sidebar export
  exportUserHeading: string;

  // Admin
  adminTitle: string;
  adminCurrentCount: (n: number) => string;
  adminCreateHeading: string;
  adminUsername: string;
  adminPassword: string;
  adminNickname: string;
  adminEmail: string;
  adminTier: string;
  adminCreate: string;
  adminConfirmDelete: (username: string) => string;
  adminYou: string;
  adminNewPasswordPlaceholder: string;

  // Profile modal
  profileTitle: string;
  profileAvatar: string;
  profileUploadAvatar: string;
  profileRemoveAvatar: string;
  profileNickname: string;
  profileEmail: string;
  profileNewPassword: string;
  profileNewPasswordPlaceholder: string;
  profileLanguage: string;
  profileSaved: string;
  profileSaveFailed: (msg: string) => string;
  profileAvatarTooLarge: (mb: number) => string;
  profileAvatarUnsupported: string;
  profileTheme: string;
  themeWinter: string;
  themeSummer: string;
  themeClaude: string;
  themeGemini: string;
  themeGrok: string;
  themeChatGPT: string;
  profileTier: string;
  profileUsage: string;
  profileUsageShow: string;
  profileUsageHide: string;
  profileUsageEmpty: string;
  profileUsageCalls: string;
  profileUsageTokens: string;
  profileUsageCost: string;
  profileUsageNote: string;
}

const ZH: Dict = {
  appName: 'AI 姐妹群',
  loading: '載入中...',
  cancel: '取消',
  save: '儲存',
  delete: '刪除',
  rename: '改名',
  close: '關閉',
  send: '送出',
  stop: '停止',
  uploading: '上傳中...',
  remove: '移除',
  loginNeeded: '請先登入',
  passwordTooShort: '密碼至少 6 個字元',
  passwordsDontMatch: '兩次輸入的密碼不一致',

  logout: '登出',
  manageUsers: '使用者管理',
  profile: '個人資料',
  langZh: '繁中',
  langEn: 'English',

  loginTitle: 'AI 姐妹群',
  loginUsernameLabel: 'Username 或 Email',
  loginPasswordLabel: '密碼',
  loginForgot: '忘記密碼？',
  loginSigningIn: '登入中...',
  loginSignIn: '登入',
  loginNoAccount: '還沒有帳號？立即註冊',
  loginHaveAccount: '已有帳號？回登入',
  signupTitle: '註冊新帳號',
  signupEmail: 'Email',
  signupPassword: '密碼（至少 6 字元）',
  signupNickname: '暱稱',
  signupSubmit: '註冊',
  signupSubmitting: '註冊中...',
  signupTierNote:
    '免費帳號每個模式每天限用 1 次，僅可使用最便宜的模型；如需升級請聯絡管理員。',
  signupUsername: '使用者名稱',
  signupUsernamePlaceholder: '英數字／. _ -，3–40 字',
  signupUsernameHint: '留空就直接用 email 當帳號名。日後不能改，請挑一個喜歡的。',
  resetUsernameLabel: '使用者名稱',
  resetUsernameHint:
    '這是你登入時用的帳號名（也可以用 email 登入）。第一次設定可以改，之後就無法修改。',
  resetWelcomeInvite: '歡迎加入！這是你第一次登入，請確認帳號名並設定密碼。',
  profileUsername: '使用者名稱（不可修改）',
  verifyBannerText: 'Email 尚未驗證，請到信箱點驗證連結後才能開始對話。',
  verifyBannerResend: '重新寄送',
  verifyBannerSent: '已重新寄出',
  verifySuccess: 'Email 驗證成功！',
  verifyFailed: (msg) => `驗證失敗：${msg}`,
  verifyVerifying: '驗證中...',
  connectionLostBanner:
    '連線中斷（可能是切換視窗或網路），伺服器仍在跑，已重新載入到目前進度。如果還沒跑完，等一下再點對應步驟旁的「重試」即可繼續。',
  connectionLostDismiss: '知道了',
  forgotTitle: '忘記密碼',
  forgotPrompt: '輸入你的帳號或 email，我們會寄重設信過去。',
  forgotSent:
    '如果這個帳號存在，我們已經寄一封重設信給註冊的 email。請查收後點擊信中連結（1 小時內有效）。',
  forgotPlaceholder: 'username 或 email',
  forgotSend: '寄送',
  forgotBack: '回登入',

  resetTitle: '重設密碼',
  resetNewLabel: '新密碼',
  resetConfirmLabel: '確認新密碼',
  resetSubmit: '確定',
  resetting: '重設中...',
  resetSuccess: '密碼已重設，請用新密碼登入。',
  resetBackLogin: '回登入頁',

  sidebarNew: '+ 新對話',
  sidebarEmpty: '還沒有對話',
  sidebarExport: '匯出',
  sidebarRename: '改名',
  sidebarDelete: '刪除',
  sidebarConfirmDelete: '刪除這個對話？',
  sidebarOpen: '開啟側邊欄',
  timeJustNow: '剛剛',
  timeMinAgo: (n) => `${n} 分鐘前`,
  timeHourAgo: (n) => `${n} 小時前`,
  timeDayAgo: (n) => `${n} 天前`,

  modeFreeName: '自由模式',
  modeFreeDesc: '同時發給四家，各自獨立回答',
  modeDebateName: '四方辯證',
  modeDebateDesc: '正方 → 反方 → 判官 → 總結',
  modeConsultName: '多方諮詢',
  modeConsultDesc: '雙源先答 → 審查 → 總結',
  modeCodingName: 'Coding 模式',
  modeCodingDesc: '規劃 → 審查 → 實作 → 測試（8 步）',
  modeRoundtableName: '道理辯證',
  modeRoundtableDesc: '5 輪辯證螺旋 × 4 人',

  modeFreeHowto1: '一個問題，4 家 AI 同時回答，並排比對。',
  modeFreeHowto2: '適合快速比較不同模型對同一問題的角度與口吻。',
  modeDebateHowto1: '4 步驟接力：正方 → 反方 → 判官 → 總結。',
  modeDebateHowto2: '適合決策題：「我該選 A 還 B」「該不該做這件事」。',
  modeConsultHowto1: '兩位 AI 並行先答 → 第三位審查比對 → 第四位綜合總結。',
  modeConsultHowto2: '適合深度諮詢：醫療、法律、技術選型 — 降低單一模型偏差。',
  modeCodingHowto1:
    '8 步雙迴圈：Planner 寫規格 → Reviewer 審 → Coder v1 → Code Review → Tester 出測試 → Coder v2 → 驗收 → 最終版。',
  modeCodingHowto2: '適合需要實際可跑代碼的任務，會比一次寫完慢但品質高。',
  modeRoundtableHowto1:
    '5 輪 × 4 人辯證螺旋：開場 → 質疑 → 攻防 → 收斂 → 真理浮現。',
  modeRoundtableHowto2: '適合開放性議題，給 AI 充分時間互相挑戰、修正、收斂。',
  modeRoundtableHowto3: '注意：這個模式會跑很久（10-30 分鐘）。',

  chatStartHere: '在下方輸入框開始對話',
  chatExpand: '▼ 展開',
  chatCollapse: '▲ 收起',
  retryFreeIdle: '重答',
  retryFreeBusy: '重新作答中...',
  retrySeqIdle: '重試並繼續',
  retrySeqBusy: '重跑中...',
  retryFreeTitle: '重新讓這個 AI 回答',
  retrySeqTitle: '從這一步重跑，後面的步驟會用新結果接著跑',
  retryFailed: (msg) => `重新作答失敗：${msg}`,
  msgCopy: '複製',
  msgCopied: '已複製',
  msgExportTablesCsv: (n) => (n > 1 ? `表格 → CSV (${n} 張)` : '表格 → CSV'),
  msgExportTablesXlsx: (n) => (n > 1 ? `表格 → Excel (${n} 張)` : '表格 → Excel'),
  msgExportPdf: '輸出 PDF',
  msgNoTables: '此訊息沒有表格',
  loadFailed: (msg) => `載入失敗：${msg}`,
  exportFailed: (msg) => `匯出失敗：${msg}`,
  deleteFailed: (msg) => `刪除失敗：${msg}`,
  renameFailed: (msg) => `改名失敗：${msg}`,

  roleDebatePro: '正方',
  roleDebateCon: '反方',
  roleDebateJudge: '判官',
  roleDebateSummary: '總結',
  roleConsultFirst: '先答 A',
  roleConsultSecond: '先答 B',
  roleConsultReviewer: '審查',
  roleConsultSummary: '總結',
  roleCodingPlanner: '規劃',
  roleCodingReviewer: '審查',
  roleCodingCoder: 'Coder',
  roleCodingTester: 'Tester',
  roleRoundtable1: '第一',
  roleRoundtable2: '第二',
  roleRoundtable3: '第三',
  roleRoundtable4: '第四',
  roleConfigShow: '▼ 角色設定',
  roleConfigHide: '▲ 收起角色設定',

  inputPlaceholderIdle: '輸入訊息... (Enter 送出, Shift+Enter 換行)',
  inputPlaceholderProcessing: '處理中...',
  inputAttachTitle: (c, m) => `附加檔案 (${c}/${m})`,
  inputFileTooLarge: (name, mb) => `${name} 超過 ${mb}MB 上限`,

  exportUserHeading: '## User',

  adminTitle: '使用者管理',
  adminCurrentCount: (n) => `目前帳號 (${n})`,
  adminCreateHeading: '新增帳號',
  adminUsername: 'username',
  adminPassword: 'password',
  adminNickname: '暱稱',
  adminEmail: 'email',
  adminTier: 'tier',
  adminCreate: '新增',
  adminConfirmDelete: (u) => `確定刪除使用者 '${u}' ?`,
  adminYou: '(本人)',
  adminNewPasswordPlaceholder: '新密碼（留空不改）',

  profileTitle: '個人資料',
  profileAvatar: '頭像',
  profileUploadAvatar: '上傳頭像',
  profileRemoveAvatar: '移除頭像',
  profileNickname: '暱稱',
  profileEmail: 'Email',
  profileNewPassword: '新密碼',
  profileNewPasswordPlaceholder: '留空不修改密碼',
  profileLanguage: '語言',
  profileSaved: '已儲存',
  profileSaveFailed: (msg) => `儲存失敗：${msg}`,
  profileAvatarTooLarge: (mb) => `頭像太大（最大 ${mb}MB）`,
  profileAvatarUnsupported: '不支援的圖片格式',
  profileTheme: '配色主題',
  themeWinter: '冬季（預設）',
  themeSummer: '夏季',
  themeClaude: 'Claude 小隊',
  themeGemini: 'Gemini 小隊',
  themeGrok: 'Grok 小隊',
  themeChatGPT: 'ChatGPT 小隊',
  profileTier: '會員等級',
  profileUsage: '我的用量',
  profileUsageShow: '▼ 顯示用量',
  profileUsageHide: '▲ 收起用量',
  profileUsageEmpty: '還沒有使用記錄',
  profileUsageCalls: '呼叫次數',
  profileUsageTokens: 'Tokens（輸入 / 輸出）',
  profileUsageCost: '累積成本',
  profileUsageNote: '以實際 token 數，並用等價 API 牌價推算。',
};

const EN: Dict = {
  appName: 'AI Sister',
  loading: 'Loading...',
  cancel: 'Cancel',
  save: 'Save',
  delete: 'Delete',
  rename: 'Rename',
  close: 'Close',
  send: 'Send',
  stop: 'Stop',
  uploading: 'Uploading...',
  remove: 'Remove',
  loginNeeded: 'Please sign in',
  passwordTooShort: 'Password must be at least 6 characters',
  passwordsDontMatch: 'Passwords do not match',

  logout: 'Sign out',
  manageUsers: 'Manage users',
  profile: 'Profile',
  langZh: '繁中',
  langEn: 'English',

  loginTitle: 'AI Sister',
  loginUsernameLabel: 'Username or Email',
  loginPasswordLabel: 'Password',
  loginForgot: 'Forgot password?',
  loginSigningIn: 'Signing in...',
  loginSignIn: 'Sign in',
  loginNoAccount: "Don't have an account? Sign up",
  loginHaveAccount: 'Have an account? Sign in',
  signupTitle: 'Create account',
  signupEmail: 'Email',
  signupPassword: 'Password (min 6 chars)',
  signupNickname: 'Nickname',
  signupSubmit: 'Sign up',
  signupSubmitting: 'Creating...',
  signupTierNote:
    'Free accounts get 1 use per mode per day on the cheapest models. Contact the admin to upgrade.',
  signupUsername: 'Username',
  signupUsernamePlaceholder: 'a-z 0-9 . _ -, 3–40 chars',
  signupUsernameHint:
    "Leave blank to use your email as the username. You can't change this later, so pick one you like.",
  resetUsernameLabel: 'Username',
  resetUsernameHint:
    'This is what you sign in with (you can also sign in with your email). You can change it on this first setup, but not afterwards.',
  resetWelcomeInvite:
    'Welcome! This is your first login — confirm your username and set your password.',
  profileUsername: 'Username (read-only)',
  verifyBannerText:
    'Email not verified yet — check your inbox and click the link before you can chat.',
  verifyBannerResend: 'Resend',
  verifyBannerSent: 'Resent',
  verifySuccess: 'Email verified!',
  verifyFailed: (msg) => `Verification failed: ${msg}`,
  verifyVerifying: 'Verifying...',
  connectionLostBanner:
    'Connection dropped (likely tab backgrounded or a network blip). The server is still running — we reloaded the latest progress. If steps are still missing, hit Retry on the failed one to continue.',
  connectionLostDismiss: 'Got it',
  forgotTitle: 'Forgot password',
  forgotPrompt:
    'Enter your username or email and we will send a reset link.',
  forgotSent:
    'If that account exists, we have sent a reset link to its email. Click the link within 1 hour.',
  forgotPlaceholder: 'username or email',
  forgotSend: 'Send',
  forgotBack: 'Back to sign in',

  resetTitle: 'Reset password',
  resetNewLabel: 'New password',
  resetConfirmLabel: 'Confirm new password',
  resetSubmit: 'Submit',
  resetting: 'Resetting...',
  resetSuccess: 'Password reset. Please sign in with the new password.',
  resetBackLogin: 'Back to sign in',

  sidebarNew: '+ New chat',
  sidebarEmpty: 'No chats yet',
  sidebarExport: 'Export',
  sidebarRename: 'Rename',
  sidebarDelete: 'Delete',
  sidebarConfirmDelete: 'Delete this chat?',
  sidebarOpen: 'Open sidebar',
  timeJustNow: 'just now',
  timeMinAgo: (n) => `${n}m ago`,
  timeHourAgo: (n) => `${n}h ago`,
  timeDayAgo: (n) => `${n}d ago`,

  modeFreeName: 'Free',
  modeFreeDesc: 'All four AIs answer in parallel',
  modeDebateName: 'Debate',
  modeDebateDesc: 'Pro → Con → Judge → Summary',
  modeConsultName: 'Consult',
  modeConsultDesc: 'Two parallel answers → review → summary',
  modeCodingName: 'Coding',
  modeCodingDesc: 'Plan → review → implement → test (8 steps)',
  modeRoundtableName: 'Roundtable',
  modeRoundtableDesc: '5-round dialectic spiral × 4 speakers',

  modeFreeHowto1: 'One question, 4 AIs answer side by side.',
  modeFreeHowto2: 'Best for quickly comparing how different models frame an answer.',
  modeDebateHowto1: '4-step relay: Pro → Con → Judge → Summary.',
  modeDebateHowto2: 'Best for decisions: "should I pick A or B", "should I do this".',
  modeConsultHowto1:
    'Two AIs answer in parallel → a third reviews → a fourth summarizes.',
  modeConsultHowto2:
    'Best for in-depth consults (medical, legal, tech choices) — reduces single-model bias.',
  modeCodingHowto1:
    '8-step double loop: Planner → Reviewer → Coder v1 → Code Review → Tester → Coder v2 → Acceptance → Final.',
  modeCodingHowto2: 'Best when you need code that actually runs — slower than one-shot, higher quality.',
  modeRoundtableHowto1:
    '5 rounds × 4 speakers, dialectic spiral: Opening → Cross-Examination → Deepening → Convergence → Truth Emerges.',
  modeRoundtableHowto2:
    'Best for open-ended topics — gives the AIs real time to challenge, revise, and converge.',
  modeRoundtableHowto3: 'Heads up: this mode runs long (10-30 min).',

  chatStartHere: 'Type below to start the conversation',
  chatExpand: '▼ Expand',
  chatCollapse: '▲ Collapse',
  retryFreeIdle: 'Retry',
  retryFreeBusy: 'Retrying...',
  retrySeqIdle: 'Retry & continue',
  retrySeqBusy: 'Replaying...',
  retryFreeTitle: 'Re-run this AI',
  retrySeqTitle: 'Replay from this step — the rest of the chain will follow',
  retryFailed: (msg) => `Retry failed: ${msg}`,
  msgCopy: 'Copy',
  msgCopied: 'Copied',
  msgExportTablesCsv: (n) => (n > 1 ? `Tables → CSV (${n})` : 'Table → CSV'),
  msgExportTablesXlsx: (n) => (n > 1 ? `Tables → Excel (${n})` : 'Table → Excel'),
  msgExportPdf: 'Export PDF',
  msgNoTables: 'No tables in this message',
  loadFailed: (msg) => `Load failed: ${msg}`,
  exportFailed: (msg) => `Export failed: ${msg}`,
  deleteFailed: (msg) => `Delete failed: ${msg}`,
  renameFailed: (msg) => `Rename failed: ${msg}`,

  roleDebatePro: 'Pro',
  roleDebateCon: 'Con',
  roleDebateJudge: 'Judge',
  roleDebateSummary: 'Summary',
  roleConsultFirst: 'First A',
  roleConsultSecond: 'First B',
  roleConsultReviewer: 'Review',
  roleConsultSummary: 'Summary',
  roleCodingPlanner: 'Planner',
  roleCodingReviewer: 'Reviewer',
  roleCodingCoder: 'Coder',
  roleCodingTester: 'Tester',
  roleRoundtable1: '1st',
  roleRoundtable2: '2nd',
  roleRoundtable3: '3rd',
  roleRoundtable4: '4th',
  roleConfigShow: '▼ Role config',
  roleConfigHide: '▲ Hide role config',

  inputPlaceholderIdle: 'Type a message... (Enter to send, Shift+Enter for newline)',
  inputPlaceholderProcessing: 'Processing...',
  inputAttachTitle: (c, m) => `Attach files (${c}/${m})`,
  inputFileTooLarge: (name, mb) => `${name} exceeds the ${mb}MB limit`,

  exportUserHeading: '## User',

  adminTitle: 'Manage users',
  adminCurrentCount: (n) => `Existing accounts (${n})`,
  adminCreateHeading: 'Create account',
  adminUsername: 'username',
  adminPassword: 'password',
  adminNickname: 'nickname',
  adminEmail: 'email',
  adminTier: 'tier',
  adminCreate: 'Create',
  adminConfirmDelete: (u) => `Delete user '${u}'?`,
  adminYou: '(you)',
  adminNewPasswordPlaceholder: 'new password (leave blank to keep)',

  profileTitle: 'Profile',
  profileAvatar: 'Avatar',
  profileUploadAvatar: 'Upload avatar',
  profileRemoveAvatar: 'Remove avatar',
  profileNickname: 'Nickname',
  profileEmail: 'Email',
  profileNewPassword: 'New password',
  profileNewPasswordPlaceholder: 'leave blank to keep current',
  profileLanguage: 'Language',
  profileSaved: 'Saved',
  profileSaveFailed: (msg) => `Save failed: ${msg}`,
  profileAvatarTooLarge: (mb) => `Avatar too large (max ${mb}MB)`,
  profileAvatarUnsupported: 'Unsupported image format',
  profileTheme: 'Color theme',
  themeWinter: 'Winter (default)',
  themeSummer: 'Summer',
  themeClaude: 'Team Claude',
  themeGemini: 'Team Gemini',
  themeGrok: 'Team Grok',
  themeChatGPT: 'Team ChatGPT',
  profileTier: 'Account tier',
  profileUsage: 'My usage',
  profileUsageShow: '▼ Show usage',
  profileUsageHide: '▲ Hide usage',
  profileUsageEmpty: 'No usage recorded yet',
  profileUsageCalls: 'Calls',
  profileUsageTokens: 'Tokens (in / out)',
  profileUsageCost: 'Total Cost',
  profileUsageNote:
    'Estimated from actual token counts at equivalent metered API pricing.',
};

// Dev instance detection: server returns the same SPA bundle on both
// hostnames, so we differentiate at runtime from window.location.host.
// Anything served on `sisters.ted-h.com` is the dev tier; everything
// else is prod (ai-sister.com / www.ai-sister.com / chat.ted-h.com /
// localhost during dev). Done once at module load — host doesn't change.
const IS_DEV_INSTANCE =
  typeof window !== 'undefined' && window.location.host === 'sisters.ted-h.com';

if (IS_DEV_INSTANCE) {
  ZH.appName = 'AI 姐妹群 - 測試站';
  ZH.loginTitle = 'AI 姐妹群 - 測試站';
  EN.appName = 'AI Sister - DEV';
  EN.loginTitle = 'AI Sister - DEV';
}

// Set the browser tab title once at boot. React's per-component title
// effects would clobber each other; doing it here (after the dict
// override above) gives one clean title for the whole tab lifecycle.
if (typeof document !== 'undefined') {
  document.title = IS_DEV_INSTANCE
    ? 'AI Sister - DEV / AI 姐妹群 - 測試站'
    : 'AI Sister / AI 姐妹群';
}

export const DICTS: Record<Lang, Dict> = { 'zh-TW': ZH, en: EN };

export const I18nContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Dict;
}>({
  lang: 'zh-TW',
  setLang: () => {},
  t: ZH,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function useT(): Dict {
  return useContext(I18nContext).t;
}

export function modeName(t: Dict, mode: ChatMode): string {
  switch (mode) {
    case 'free': return t.modeFreeName;
    case 'debate': return t.modeDebateName;
    case 'consult': return t.modeConsultName;
    case 'coding': return t.modeCodingName;
    case 'roundtable': return t.modeRoundtableName;
  }
}

export function modeDesc(t: Dict, mode: ChatMode): string {
  switch (mode) {
    case 'free': return t.modeFreeDesc;
    case 'debate': return t.modeDebateDesc;
    case 'consult': return t.modeConsultDesc;
    case 'coding': return t.modeCodingDesc;
    case 'roundtable': return t.modeRoundtableDesc;
  }
}

export function modeHowto(t: Dict, mode: ChatMode): string[] {
  switch (mode) {
    case 'free': return [t.modeFreeHowto1, t.modeFreeHowto2];
    case 'debate': return [t.modeDebateHowto1, t.modeDebateHowto2];
    case 'consult': return [t.modeConsultHowto1, t.modeConsultHowto2];
    case 'coding': return [t.modeCodingHowto1, t.modeCodingHowto2];
    case 'roundtable':
      return [
        t.modeRoundtableHowto1,
        t.modeRoundtableHowto2,
        t.modeRoundtableHowto3,
      ];
  }
}
