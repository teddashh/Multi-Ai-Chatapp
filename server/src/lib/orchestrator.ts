import { runCLI } from './cli.js';
import { resolveModel } from '../shared/models.js';
import { PROMPTS, PROVIDER_NAMES } from '../shared/prompts.js';
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

export interface OrchestratorParams {
  text: string;
  mode: ChatMode;
  roles?: ModeRoles;
  tier: Tier;
  modelOverrides?: Partial<Record<AIProvider, string>>;
  attachments?: PreparedAttachment[];
  emit: (event: SSEEvent) => void;
  signal: AbortSignal;
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
const ROUND_LABELS = ['開場立論', '交叉質疑', '攻防深化', '核心收斂', '真理浮現'];

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
  try {
    const result = await runCLI({
      provider,
      model,
      prompt: finalPrompt,
      attachments,
      signal: p.signal,
      onChunk: (text) => p.emit({ type: 'chunk', provider, text }),
    });
    p.emit({ type: 'done', provider, text: result.text });
    return result.text;
  } catch (err) {
    const message = (err as Error).message;
    p.emit({ type: 'error', provider, message });
    p.emit({ type: 'done', provider, text: `[Error: ${message}]` });
    throw err;
  }
}

export function buildStepList(mode: ChatMode, roles: ModeRoles): StepSpec[] {
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
          label: '正方',
          workflowStatus: `⚔️ 正方 ${proName} 論述中...`,
          buildPrompt: (q) => PROMPTS.debate.pro(q),
        },
        {
          provider: r.con,
          role: 'con',
          label: '反方',
          workflowStatus: `⚔️ 反方 ${conName} 反駁中...`,
          buildPrompt: (q, h) => PROMPTS.debate.con(q, h[0].text),
        },
        {
          provider: r.judge,
          role: 'judge',
          label: '判官',
          workflowStatus: `⚔️ 判官 ${judgeName} 評析中...`,
          buildPrompt: (q, h) => PROMPTS.debate.judge(q, h[0].text, h[1].text),
        },
        {
          provider: r.summary,
          role: 'summary',
          label: '總結',
          workflowStatus: `⚔️ ${sumName} 歸納總結中...`,
          buildPrompt: (q, h) =>
            PROMPTS.debate.summary(q, h[0].text, h[1].text, h[2].text),
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
          label: '先答 A',
          workflowStatus: `🔍 ${firstName} 回答中...`,
          buildPrompt: (q) => PROMPTS.consult.first(q),
        },
        {
          provider: r.second,
          role: 'second',
          label: '先答 B',
          workflowStatus: `🔍 ${secondName} 回答中...`,
          buildPrompt: (q) => PROMPTS.consult.second(q),
        },
        {
          provider: r.reviewer,
          role: 'reviewer',
          label: '審查',
          workflowStatus: `🔍 ${reviewerName} 審查中...`,
          buildPrompt: (q, h) =>
            PROMPTS.consult.reviewer(
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
          label: '總結',
          workflowStatus: `🔍 ${sumName} 總結中...`,
          buildPrompt: (q, h) =>
            PROMPTS.consult.summary(
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
      return [
        {
          provider: r.planner,
          role: 'planner',
          label: '規劃師',
          workflowStatus: `💻 Step 1/8 — ${plannerName} 撰寫規格中...`,
          buildPrompt: (q) => PROMPTS.coding.plannerSpec(q),
        },
        {
          provider: r.reviewer,
          role: 'reviewer',
          label: '審查者',
          workflowStatus: `💻 Step 2/8 — ${reviewerName} 審查規格中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.reviewerSpec(q, h[0].text, plannerName),
        },
        {
          provider: r.coder,
          role: 'coder',
          label: 'Coder',
          workflowStatus: `💻 Step 3/8 — ${coderName} 撰寫 v1 中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.coderV1(
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
          label: 'Code Review',
          workflowStatus: `💻 Step 4/8 — ${reviewerName} Code Review 中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.reviewerCode(q, h[2].text, coderName),
        },
        {
          provider: r.tester,
          role: 'tester',
          label: 'Tester',
          workflowStatus: `💻 Step 5/8 — ${testerName} 測試分析中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.testerCases(q, h[2].text, coderName),
        },
        {
          provider: r.coder,
          role: 'coder',
          label: 'v2 修正',
          workflowStatus: `💻 Step 6/8 — ${coderName} 修正 → v2 中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.coderV2(
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
          label: '驗收',
          workflowStatus: `💻 Step 7/8 — ${plannerName} 驗收中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.plannerAcceptance(q, h[5].text, coderName, h[0].text),
        },
        {
          provider: r.coder,
          role: 'coder',
          label: '最終版',
          workflowStatus: `💻 Step 8/8 — ${coderName} 最終修正中...`,
          buildPrompt: (q, h) =>
            PROMPTS.coding.coderFinal(q, h[5].text, h[6].text, plannerName),
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
          const roundLabel = ROUND_LABELS[round - 1];
          const cur = round;
          steps.push({
            provider: speaker,
            role: `R${cur}`,
            label: `第${cur}輪`,
            workflowStatus: `🔄 第${cur}輪「${roundLabel}」— ${speakerName} 發言中...`,
            buildPrompt: (q, h) => {
              const rtHistory = h.map((s) => ({
                name: PROVIDER_NAMES[s.provider],
                round: parseInt(s.modeRole.replace(/[^0-9]/g, ''), 10) || 0,
                text: s.text,
              }));
              return PROMPTS.roundtable.buildPrompt(q, cur, speakerName, rtHistory);
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
  const steps = buildStepList(p.mode, roles);
  await runSequential(p, steps);
}

async function runFree(p: OrchestratorParams): Promise<void> {
  p.emit({
    type: 'workflow',
    status: `⚡ ${ALL_PROVIDERS.map((x) => PROVIDER_NAMES[x]).join('、')} 同時作答中...`,
  });
  await Promise.all(
    ALL_PROVIDERS.map((provider) => runOne(p, provider, p.text).catch(() => {})),
  );
  p.emit({ type: 'workflow', status: '' });
}

async function runSequential(
  p: OrchestratorParams,
  steps: StepSpec[],
): Promise<void> {
  const history: StepResult[] = [];
  for (const step of steps) {
    p.emit({ type: 'workflow', status: step.workflowStatus });
    p.emit({
      type: 'role',
      provider: step.provider,
      role: step.role,
      label: step.label,
    });
    const prompt = step.buildPrompt(p.text, history);
    const text = await runOne(p, step.provider, prompt);
    history.push({ provider: step.provider, modeRole: step.label, text });
  }
  p.emit({ type: 'workflow', status: '' });
}
