import { classifyError, recordCallFailure, runCLI, type CLIRunOptions } from './cli.js';
import { runOpenRouter } from './providers/openrouter.js';
import { runAnthropic } from './providers/anthropic.js';
import { runOpenAI } from './providers/openai.js';
import { runGemini } from './providers/gemini.js';
import { auditStmts, usageStmts } from './db.js';
import { resolveModel } from '../shared/models.js';
import { getPrompts, PROVIDER_NAMES, type Lang } from '../shared/prompts.js';
import type { MessageRow } from './db.js';
import {
  buildAttachmentPrefix,
  type PreparedAttachment,
} from './uploads.js';
import type {
  AIProvider,
  ChatMode,
  CodingRoles,
  ConsultRoles,
  DebateRoles,
  ModeRoles,
  RoundtableRoles,
  SSEEvent,
  Tier,
} from '../shared/types.js';

// One step in a multi-turn conversation. Used both for the Grok messages
// array we ship to xAI and for the prompt-prefix transcript we build for
// the CLI providers.
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Skip rows whose AI output was an error so we don't feed garbage back
// to the next turn as if it were real conversation history.
function isUsableMessage(m: MessageRow): boolean {
  if (m.role === 'user') return true;
  return !m.content.startsWith('[Error:');
}

// Per-provider history — each AI gets its own thread (their replies +
// every user message). Two caps to keep prompts from growing into
// CLI-choking territory: a turn count and a per-message char budget.
// Long sessions in sequential modes were running into "我現在狀況不太好"
// failures because the combined prompt + history was past the CLI's
// comfort zone.
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_MSG_CHARS = 1500;

function trimContent(s: string): string {
  if (s.length <= MAX_HISTORY_MSG_CHARS) return s;
  return s.slice(0, MAX_HISTORY_MSG_CHARS) + '…';
}

export function buildPerProviderHistory(
  messages: MessageRow[],
): Partial<Record<AIProvider, ChatTurn[]>> {
  const usable = messages.filter(isUsableMessage);
  const out: Partial<Record<AIProvider, ChatTurn[]>> = {};
  const providers: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];
  for (const p of providers) {
    const turns: ChatTurn[] = [];
    let pendingUser: string | null = null;
    for (const m of usable) {
      if (m.role === 'user') {
        // Always include user msgs — but only emit them once we have a
        // following assistant response from this provider, otherwise the
        // assistant would see "user x4 in a row" with no replies.
        pendingUser = m.content;
      } else if (m.provider === p && pendingUser !== null) {
        turns.push({ role: 'user', content: trimContent(pendingUser) });
        turns.push({ role: 'assistant', content: trimContent(m.content) });
        pendingUser = null;
      }
    }
    if (turns.length > 0) {
      // Keep only the last MAX_HISTORY_TURNS pairs (each pair = 2 entries).
      const trimmed = turns.slice(-MAX_HISTORY_TURNS * 2);
      out[p] = trimmed;
    }
  }
  return out;
}

// (No buildSharedHistoryPrefix — sequential modes also use
// per-provider history now. Each AI sees only its own past thread, so
// it never reads other agents' "第二輪" labels and gets dragged into
// mimicking them. Within-turn multi-agent dialogue is unaffected
// because the orchestrator already passes prior step outputs into the
// next step's prompt builder.)

export interface OrchestratorParams {
  text: string;
  mode: ChatMode;
  roles?: ModeRoles;
  tier: Tier;
  lang: Lang;
  userId: number;
  // Used in audit_log when an OpenRouter fallback fires, so admin can
  // jump from a fallback event back to the originating session.
  sessionId?: string;
  modelOverrides?: Partial<Record<AIProvider, string>>;
  attachments?: PreparedAttachment[];
  emit: (event: SSEEvent) => void;
  signal: AbortSignal;
  // Per-provider conversation history from earlier turns of the same
  // session. Free mode passes this through so each AI sees its own
  // thread; sequential modes embed a flattened transcript into `text`
  // before calling runMode, leaving this empty.
  history?: Partial<Record<AIProvider, ChatTurn[]>>;
}

export const DEFAULT_DEBATE_ROLES: DebateRoles = {
  pro: 'chatgpt',
  con: 'claude',
  judge: 'grok',
  summary: 'gemini',
};
export const DEFAULT_CONSULT_ROLES: ConsultRoles = {
  first: 'chatgpt',
  second: 'grok',
  reviewer: 'claude',
  summary: 'gemini',
};
export const DEFAULT_CODING_ROLES: CodingRoles = {
  planner: 'gemini',
  reviewer: 'chatgpt',
  coder: 'claude',
  tester: 'grok',
};
export const DEFAULT_ROUNDTABLE_ROLES: RoundtableRoles = {
  first: 'claude',
  second: 'gemini',
  third: 'grok',
  fourth: 'chatgpt',
};

export function defaultRolesFor(mode: ChatMode): ModeRoles | null {
  switch (mode) {
    case 'debate':
      return DEFAULT_DEBATE_ROLES;
    case 'consult':
      return DEFAULT_CONSULT_ROLES;
    case 'coding':
      return DEFAULT_CODING_ROLES;
    case 'roundtable':
      return DEFAULT_ROUNDTABLE_ROLES;
    default:
      return null;
  }
}

export interface StepResult {
  provider: AIProvider;
  modeRole: string;
  text: string;
}

export interface StepSpec {
  provider: AIProvider;
  role: string;
  label: string;
  workflowStatus: string;
  buildPrompt: (userText: string, history: StepResult[]) => string;
}

const ALL_PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

// === Lang-aware static labels for sequential modes ===
// These show up in the UI as `mode_role` and in workflow status. Persisted
// alongside the AI message content in the DB; resume can look them up by
// position so they don't need to round-trip through anything.
interface ModeLabels {
  roundLabels: string[];
  debate: { pro: string; con: string; judge: string; summary: string };
  consult: { first: string; second: string; reviewer: string; summary: string };
  coding: {
    planner: string;
    reviewerSpec: string;
    coder: string;
    codeReview: string;
    tester: string;
    coderV2: string;
    accept: string;
    final: string;
  };
  roundLabel: (round: number) => string;
  // Workflow status formatters.
  fmt: {
    free: (names: string[]) => string;
    debatePro: (name: string) => string;
    debateCon: (name: string) => string;
    debateJudge: (name: string) => string;
    debateSummary: (name: string) => string;
    consultFirst: (name: string) => string;
    consultSecond: (name: string) => string;
    consultReviewer: (name: string) => string;
    consultSummary: (name: string) => string;
    codingStep: (n: number, name: string, what: string) => string;
    codingWords: {
      plannerSpec: string;
      reviewerSpec: string;
      coderV1: string;
      reviewerCode: string;
      tester: string;
      coderV2: string;
      accept: string;
      final: string;
    };
    roundtable: (round: number, roundName: string, name: string) => string;
  };
}

const LABELS_ZH: ModeLabels = {
  roundLabels: ['開場立論', '交叉質疑', '攻防深化', '核心收斂', '真理浮現'],
  debate: { pro: '正方', con: '反方', judge: '判官', summary: '總結' },
  consult: { first: '先答 A', second: '先答 B', reviewer: '審查', summary: '總結' },
  coding: {
    planner: '規劃師',
    reviewerSpec: '審查者',
    coder: 'Coder',
    codeReview: 'Code Review',
    tester: 'Tester',
    coderV2: 'v2 修正',
    accept: '驗收',
    final: '最終版',
  },
  roundLabel: (r) => `第${r}輪`,
  fmt: {
    free: (names) => `${names.join('、')} 同時作答中...`,
    debatePro: (n) => `正方 ${n} 論述中...`,
    debateCon: (n) => `反方 ${n} 反駁中...`,
    debateJudge: (n) => `判官 ${n} 評析中...`,
    debateSummary: (n) => `${n} 歸納總結中...`,
    consultFirst: (n) => `${n} 回答中...`,
    consultSecond: (n) => `${n} 回答中...`,
    consultReviewer: (n) => `${n} 審查中...`,
    consultSummary: (n) => `${n} 總結中...`,
    codingStep: (n, name, what) => `Step ${n}/8 — ${name} ${what}`,
    codingWords: {
      plannerSpec: '撰寫規格中...',
      reviewerSpec: '審查規格中...',
      coderV1: '撰寫 v1 中...',
      reviewerCode: 'Code Review 中...',
      tester: '測試分析中...',
      coderV2: '修正 → v2 中...',
      accept: '驗收中...',
      final: '最終修正中...',
    },
    roundtable: (round, rName, n) => `第${round}輪「${rName}」— ${n} 發言中...`,
  },
};

const LABELS_EN: ModeLabels = {
  roundLabels: [
    'Opening',
    'Cross-Examination',
    'Deepening',
    'Convergence',
    'Truth Emerges',
  ],
  debate: { pro: 'Pro', con: 'Con', judge: 'Judge', summary: 'Summary' },
  consult: {
    first: 'First A',
    second: 'First B',
    reviewer: 'Reviewer',
    summary: 'Summary',
  },
  coding: {
    planner: 'Planner',
    reviewerSpec: 'Spec Review',
    coder: 'Coder',
    codeReview: 'Code Review',
    tester: 'Tester',
    coderV2: 'v2',
    accept: 'Acceptance',
    final: 'Final',
  },
  roundLabel: (r) => `Round ${r}`,
  fmt: {
    free: (names) => `${names.join(', ')} answering in parallel...`,
    debatePro: (n) => `Pro side — ${n} arguing...`,
    debateCon: (n) => `Con side — ${n} rebutting...`,
    debateJudge: (n) => `Judge ${n} analyzing...`,
    debateSummary: (n) => `${n} synthesizing...`,
    consultFirst: (n) => `${n} answering...`,
    consultSecond: (n) => `${n} answering...`,
    consultReviewer: (n) => `${n} reviewing...`,
    consultSummary: (n) => `${n} summarizing...`,
    codingStep: (n, name, what) => `Step ${n}/8 — ${name} ${what}`,
    codingWords: {
      plannerSpec: 'writing spec...',
      reviewerSpec: 'reviewing spec...',
      coderV1: 'writing v1...',
      reviewerCode: 'doing code review...',
      tester: 'analyzing tests...',
      coderV2: 'producing v2...',
      accept: 'doing acceptance...',
      final: 'final polish...',
    },
    roundtable: (round, rName, n) =>
      `Round ${round} "${rName}" — ${n} speaking...`,
  },
};

function labelsFor(lang: Lang): ModeLabels {
  return lang === 'en' ? LABELS_EN : LABELS_ZH;
}

// Retryable error codes — the primary failure was likely transient (rate
// limit, timeout, server error, network blip) and worth a fallback. We
// skip 401/403 (config issue, won't help to retry on OR) and 'aborted'
// (user cancelled).
const FALLBACK_CODES = new Set(['429', '5xx', 'timeout', 'network', 'other']);

// Single global flag controls whether the primary stage is the vendor's
// CLI (PROVIDER_MODE=cli, dev) or its direct API (PROVIDER_MODE=api, prod).
// In either mode the chain ends with OpenRouter as a last-resort fallback.
const PROVIDER_MODE = (process.env.PROVIDER_MODE ?? 'cli') === 'api' ? 'api' : 'cli';

interface StageResult {
  text: string;
  modelUsed: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

interface ChainStage {
  // Identifier for usage_log/audit_log: 'cli' | 'claude_api' | 'gemini_api' |
  // 'chatgpt_api' | 'openrouter'. CLI's recordUsage handles its own
  // usage_log row; every other stage logs through the chain runner.
  name: string;
  run: () => Promise<StageResult>;
}

// Direct vendor APIs — keys here have a fast path. Grok already runs
// xAI directly inside runCLI, so it's deliberately absent.
type ApiRunner = (opts: CLIRunOptions) => Promise<StageResult>;
const NATIVE_API: Partial<Record<AIProvider, ApiRunner>> = {
  claude: runAnthropic,
  chatgpt: runOpenAI,
  gemini: runGemini,
};

function nativeApiAvailable(provider: AIProvider): boolean {
  if (!NATIVE_API[provider]) return false;
  // Only enable the api stage when the vendor's key is actually set —
  // otherwise we'd 401 and fall through pointlessly.
  switch (provider) {
    case 'claude':
      return !!process.env.ANTHROPIC_API_KEY;
    case 'chatgpt':
      return !!process.env.OPENAI_API_KEY;
    case 'gemini':
      return !!process.env.GEMINI_API_KEY;
    default:
      return false;
  }
}

function buildStages(
  baseOpts: CLIRunOptions,
  provider: AIProvider,
  model: string,
): ChainStage[] {
  const cliStage: ChainStage = {
    name: 'cli',
    run: async () => {
      const r = await runCLI(baseOpts);
      // runCLI's success path already logs usage; we pass through with
      // null token counts so the chain runner's bookkeeping doesn't
      // double-insert.
      return { text: r.text, modelUsed: model, promptTokens: null, completionTokens: null };
    },
  };
  const apiStage: ChainStage | null =
    NATIVE_API[provider] && nativeApiAvailable(provider)
      ? { name: `${provider}_api`, run: () => NATIVE_API[provider]!(baseOpts) }
      : null;
  const orStage: ChainStage | null = process.env.OPENROUTER_API_KEY
    ? { name: 'openrouter', run: () => runOpenRouter(baseOpts) }
    : null;

  const stages: ChainStage[] = [];
  if (PROVIDER_MODE === 'api') {
    // Skip the CLI entirely if a direct API is wired up; otherwise fall
    // back to CLI as primary so the request still goes through.
    if (apiStage) stages.push(apiStage);
    else stages.push(cliStage);
  } else {
    stages.push(cliStage);
    if (apiStage) stages.push(apiStage);
  }
  if (orStage) stages.push(orStage);
  return stages;
}

interface JourneyEntry {
  stage: string;
  outcome: 'success' | 'failed';
  model?: string;
  error?: string;
}

function writeChainAudit(
  p: OrchestratorParams,
  provider: AIProvider,
  primaryModel: string,
  journey: JourneyEntry[],
): void {
  try {
    auditStmts.insert.run(
      p.userId,
      p.userId,
      p.sessionId ?? null,
      'model_fallback',
      JSON.stringify({
        provider,
        primary_model: primaryModel,
        mode: p.mode ?? null,
        journey,
      }),
    );
  } catch (e) {
    console.error('audit fallback insert failed', (e as Error).message);
  }
}

export async function runOne(
  p: OrchestratorParams,
  provider: AIProvider,
  prompt: string,
): Promise<string> {
  const model = resolveModel(p.tier, provider, p.modelOverrides?.[provider]);
  const attachments = p.attachments ?? [];
  const finalPrompt = attachments.length > 0
    ? buildAttachmentPrefix(attachments) + prompt
    : prompt;

  const baseOpts: CLIRunOptions = {
    provider,
    model,
    prompt: finalPrompt,
    attachments,
    signal: p.signal,
    onChunk: (text) => p.emit({ type: 'chunk', provider, text }),
    userId: p.userId,
    mode: p.mode,
    history: p.history?.[provider],
  };

  const stages = buildStages(baseOpts, provider, model);
  const journey: JourneyEntry[] = [];
  let lastErr: Error | null = null;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isPrimary = i === 0;

    // Wipe partial bubble + show bridge line for any non-primary stage.
    if (!isPrimary) {
      p.emit({ type: 'fallback_notice', provider, message: bridgeText(p.lang) });
    }

    try {
      const result = await stage.run();
      journey.push({ stage: stage.name, outcome: 'success', model: result.modelUsed });

      // Only log usage manually for non-cli stages — the CLI path already
      // wrote its own usage_log row inside runCLI on success.
      if (stage.name !== 'cli') {
        try {
          const logModel =
            stage.name === 'openrouter'
              ? `openrouter:${result.modelUsed}`
              : `${stage.name}:${result.modelUsed}`;
          usageStmts.insert.run(
            p.userId,
            provider,
            logModel,
            p.mode ?? null,
            finalPrompt.length,
            result.text.length,
            result.promptTokens,
            result.completionTokens,
            result.promptTokens === null || result.completionTokens === null ? 1 : 0,
            1,
            null,
          );
        } catch (e) {
          console.error('usage_log fallback insert failed', (e as Error).message);
        }
      }

      if (!isPrimary) writeChainAudit(p, provider, model, journey);
      p.emit({ type: 'done', provider, text: result.text });
      return result.text;
    } catch (err) {
      lastErr = err as Error;
      const code = classifyError(err);
      console.error(`[${provider}] ${stage.name} failed (${code}):`, lastErr.message);
      journey.push({
        stage: stage.name,
        outcome: 'failed',
        model,
        error: code,
      });

      // Record the failure in usage_log. CLI's runCLI throws WITHOUT
      // writing usage_log on the failure path, so we own that here too.
      const failModel =
        stage.name === 'cli' ? model : `${stage.name}:${model}`;
      recordCallFailure({
        userId: p.userId,
        provider,
        model: failModel,
        mode: p.mode,
        promptChars: finalPrompt.length,
        errorCode: code,
      });

      // Stop chain immediately on non-retryable errors (auth, abort, spawn).
      if (!FALLBACK_CODES.has(code)) {
        if (!isPrimary) writeChainAudit(p, provider, model, journey);
        p.emit({ type: 'error', provider, message: lastErr.message });
        p.emit({
          type: 'done',
          provider,
          text: isPrimary ? failureText(p.lang) : exhaustedFallbackText(p.lang),
        });
        throw lastErr;
      }
      // Retryable — continue to next stage if any.
    }
  }

  // All stages exhausted on retryable errors. Audit the full journey
  // and surface the quota-exhausted message.
  writeChainAudit(p, provider, model, journey);
  p.emit({
    type: 'error',
    provider,
    message: lastErr?.message ?? 'all fallback stages failed',
  });
  p.emit({
    type: 'done',
    provider,
    text: stages.length > 1 ? exhaustedFallbackText(p.lang) : failureText(p.lang),
  });
  throw lastErr ?? new Error('chain exhausted');
}

export function buildStepList(
  mode: ChatMode,
  roles: ModeRoles,
  lang: Lang = 'zh-TW',
): StepSpec[] {
  const L = labelsFor(lang);
  const P = getPrompts(lang);
  switch (mode) {
    case 'debate': {
      const r = roles as DebateRoles;
      const proName = PROVIDER_NAMES[r.pro];
      const conName = PROVIDER_NAMES[r.con];
      const judgeName = PROVIDER_NAMES[r.judge];
      const sumName = PROVIDER_NAMES[r.summary];
      return [
        {
          provider: r.pro,
          role: 'pro',
          label: L.debate.pro,
          workflowStatus: L.fmt.debatePro(proName),
          buildPrompt: (q) => P.debate.pro(q),
        },
        {
          provider: r.con,
          role: 'con',
          label: L.debate.con,
          workflowStatus: L.fmt.debateCon(conName),
          buildPrompt: (q, h) => P.debate.con(q, h[0].text),
        },
        {
          provider: r.judge,
          role: 'judge',
          label: L.debate.judge,
          workflowStatus: L.fmt.debateJudge(judgeName),
          buildPrompt: (q, h) => P.debate.judge(q, h[0].text, h[1].text),
        },
        {
          provider: r.summary,
          role: 'summary',
          label: L.debate.summary,
          workflowStatus: L.fmt.debateSummary(sumName),
          buildPrompt: (q, h) =>
            P.debate.summary(q, h[0].text, h[1].text, h[2].text),
        },
      ];
    }
    case 'consult': {
      const r = roles as ConsultRoles;
      const firstName = PROVIDER_NAMES[r.first];
      const secondName = PROVIDER_NAMES[r.second];
      const reviewerName = PROVIDER_NAMES[r.reviewer];
      const sumName = PROVIDER_NAMES[r.summary];
      return [
        {
          provider: r.first,
          role: 'first',
          label: L.consult.first,
          workflowStatus: L.fmt.consultFirst(firstName),
          buildPrompt: (q) => P.consult.first(q),
        },
        {
          provider: r.second,
          role: 'second',
          label: L.consult.second,
          workflowStatus: L.fmt.consultSecond(secondName),
          buildPrompt: (q) => P.consult.second(q),
        },
        {
          provider: r.reviewer,
          role: 'reviewer',
          label: L.consult.reviewer,
          workflowStatus: L.fmt.consultReviewer(reviewerName),
          buildPrompt: (q, h) =>
            P.consult.reviewer(
              q,
              h[0].text,
              firstName,
              h[1].text,
              secondName,
            ),
        },
        {
          provider: r.summary,
          role: 'summary',
          label: L.consult.summary,
          workflowStatus: L.fmt.consultSummary(sumName),
          buildPrompt: (q, h) =>
            P.consult.summary(
              q,
              h[0].text,
              firstName,
              h[1].text,
              secondName,
              h[2].text,
              reviewerName,
            ),
        },
      ];
    }
    case 'coding': {
      const r = roles as CodingRoles;
      const plannerName = PROVIDER_NAMES[r.planner];
      const reviewerName = PROVIDER_NAMES[r.reviewer];
      const coderName = PROVIDER_NAMES[r.coder];
      const testerName = PROVIDER_NAMES[r.tester];
      const W = L.fmt.codingWords;
      return [
        {
          provider: r.planner,
          role: 'planner',
          label: L.coding.planner,
          workflowStatus: L.fmt.codingStep(1, plannerName, W.plannerSpec),
          buildPrompt: (q) => P.coding.plannerSpec(q),
        },
        {
          provider: r.reviewer,
          role: 'reviewer',
          label: L.coding.reviewerSpec,
          workflowStatus: L.fmt.codingStep(2, reviewerName, W.reviewerSpec),
          buildPrompt: (q, h) =>
            P.coding.reviewerSpec(q, h[0].text, plannerName),
        },
        {
          provider: r.coder,
          role: 'coder',
          label: L.coding.coder,
          workflowStatus: L.fmt.codingStep(3, coderName, W.coderV1),
          buildPrompt: (q, h) =>
            P.coding.coderV1(
              q,
              h[0].text,
              plannerName,
              h[1].text,
              reviewerName,
            ),
        },
        {
          provider: r.reviewer,
          role: 'reviewer',
          label: L.coding.codeReview,
          workflowStatus: L.fmt.codingStep(4, reviewerName, W.reviewerCode),
          buildPrompt: (q, h) =>
            P.coding.reviewerCode(q, h[2].text, coderName),
        },
        {
          provider: r.tester,
          role: 'tester',
          label: L.coding.tester,
          workflowStatus: L.fmt.codingStep(5, testerName, W.tester),
          buildPrompt: (q, h) =>
            P.coding.testerCases(q, h[2].text, coderName),
        },
        {
          provider: r.coder,
          role: 'coder',
          label: L.coding.coderV2,
          workflowStatus: L.fmt.codingStep(6, coderName, W.coderV2),
          buildPrompt: (q, h) =>
            P.coding.coderV2(
              q,
              h[2].text,
              h[3].text,
              reviewerName,
              h[4].text,
              testerName,
            ),
        },
        {
          provider: r.planner,
          role: 'planner',
          label: L.coding.accept,
          workflowStatus: L.fmt.codingStep(7, plannerName, W.accept),
          buildPrompt: (q, h) =>
            P.coding.plannerAcceptance(q, h[5].text, coderName, h[0].text),
        },
        {
          provider: r.coder,
          role: 'coder',
          label: L.coding.final,
          workflowStatus: L.fmt.codingStep(8, coderName, W.final),
          buildPrompt: (q, h) =>
            P.coding.coderFinal(q, h[5].text, h[6].text, plannerName),
        },
      ];
    }
    case 'roundtable': {
      const r = roles as RoundtableRoles;
      const speakers: AIProvider[] = [r.first, r.second, r.third, r.fourth];
      const steps: StepSpec[] = [];
      for (let round = 1; round <= 5; round++) {
        for (const speaker of speakers) {
          const speakerName = PROVIDER_NAMES[speaker];
          const roundName = L.roundLabels[round - 1];
          const cur = round;
          steps.push({
            provider: speaker,
            role: `R${cur}`,
            label: L.roundLabel(cur),
            workflowStatus: L.fmt.roundtable(cur, roundName, speakerName),
            buildPrompt: (q, h) => {
              const rtHistory = h.map((s) => ({
                name: PROVIDER_NAMES[s.provider],
                round: parseInt(s.modeRole.replace(/[^0-9]/g, ''), 10) || 0,
                text: s.text,
              }));
              return P.roundtable.buildPrompt(q, cur, speakerName, rtHistory);
            },
          });
        }
      }
      return steps;
    }
    default:
      return [];
  }
}

export async function runMode(p: OrchestratorParams): Promise<void> {
  if (p.mode === 'free') {
    await runFree(p);
    return;
  }
  const roles = p.roles ?? defaultRolesFor(p.mode);
  if (!roles) {
    throw new Error(`unknown mode ${p.mode}`);
  }
  const steps = buildStepList(p.mode, roles, p.lang);
  await runSequential(p, steps);
}

async function runFree(p: OrchestratorParams): Promise<void> {
  const L = labelsFor(p.lang);
  p.emit({
    type: 'workflow',
    status: L.fmt.free(ALL_PROVIDERS.map((x) => PROVIDER_NAMES[x])),
  });
  await Promise.all(
    ALL_PROVIDERS.map((provider) => runOne(p, provider, p.text).catch(() => {})),
  );
  p.emit({ type: 'workflow', status: '' });
}

// User-facing fallback when an AI step fails (CLI hiccup, 429, abort,
// etc). The text is in-character — sounds like the AI itself is saying
// "I'm having a bad moment, please retry" — instead of a raw error blob.
// Same string is used both as the displayed message and as the entry
// downstream steps see in their history.
export function failureText(lang: Lang): string {
  return lang === 'en'
    ? "I'm not feeling great right now and don't know how to respond. Please give me a moment and hit Retry to try again."
    : '我現在狀況不太好，不知道該怎麼回，暫時沒有回應。請你等等幫我按一下「重試」。';
}

// Bridging line shown briefly before the OpenRouter fallback starts streaming.
// The user must NOT learn that a different model is taking over — keep the
// tone first-person / in-character.
export function bridgeText(lang: Lang): string {
  return lang === 'en'
    ? 'Let me think about this differently — give me a sec...'
    : '我換個方式思考一下，請等等...';
}

// Shown when even the OpenRouter fallback fails (we're out of free credits
// or OR also returned 429). Treats it as a quota exhaustion rather than a
// system error so the upgrade CTA reads naturally.
export function exhaustedFallbackText(lang: Lang): string {
  return lang === 'en'
    ? "Sorry, you've used up today's free quota. Consider upgrading your account for a higher daily limit."
    : '抱歉，你已經用完今天的免費額度了，可以考慮升級你的帳號，獲得更多的每日額度。';
}

async function runSequential(
  p: OrchestratorParams,
  steps: StepSpec[],
): Promise<void> {
  const history: StepResult[] = [];
  for (const step of steps) {
    // User aborted the whole stream — don't keep firing CLI calls.
    if (p.signal.aborted) break;
    p.emit({ type: 'workflow', status: step.workflowStatus });
    p.emit({
      type: 'role',
      provider: step.provider,
      role: step.role,
      label: step.label,
    });
    const prompt = step.buildPrompt(p.text, history);
    let text: string;
    try {
      text = await runOne(p, step.provider, prompt);
    } catch (err) {
      // One CLI hiccup shouldn't kill a 20-step roundtable. Log the error
      // (already surfaced via the 'done [Error: ...]' event from runOne)
      // and keep walking. The failed message is persisted by the route's
      // recordingSend, so the user can retry that single step later.
      if (p.signal.aborted) break;
      console.error(
        `step ${step.label}/${step.provider} failed:`,
        (err as Error).message,
      );
      text = failureText(p.lang);
    }
    history.push({ provider: step.provider, modeRole: step.label, text });
  }
  p.emit({ type: 'workflow', status: '' });
}
