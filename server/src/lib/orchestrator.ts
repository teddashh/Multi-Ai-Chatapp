import { runCLI } from './cli.js';
import { resolveModel } from '../shared/models.js';
import { PROMPTS, PROVIDER_NAMES } from '../shared/prompts.js';
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

const ALL_PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];
const ROUND_LABELS = ['開場立論', '交叉質疑', '攻防深化', '核心收斂', '真理浮現'];

async function runOne(
  p: OrchestratorParams,
  provider: AIProvider,
  prompt: string,
): Promise<string> {
  const model = resolveModel(p.tier, provider, p.modelOverrides?.[provider]);
  try {
    const result = await runCLI({
      provider,
      model,
      prompt,
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

export async function runMode(p: OrchestratorParams): Promise<void> {
  switch (p.mode) {
    case 'free':
      await runFree(p);
      break;
    case 'debate':
      await runDebate(p, (p.roles as DebateRoles) ?? DEFAULT_DEBATE_ROLES);
      break;
    case 'consult':
      await runConsult(p, (p.roles as ConsultRoles) ?? DEFAULT_CONSULT_ROLES);
      break;
    case 'coding':
      await runCoding(p, (p.roles as CodingRoles) ?? DEFAULT_CODING_ROLES);
      break;
    case 'roundtable':
      await runRoundtable(
        p,
        (p.roles as RoundtableRoles) ?? DEFAULT_ROUNDTABLE_ROLES,
      );
      break;
  }
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

async function runDebate(p: OrchestratorParams, r: DebateRoles): Promise<void> {
  const proName = PROVIDER_NAMES[r.pro];
  const conName = PROVIDER_NAMES[r.con];
  const judgeName = PROVIDER_NAMES[r.judge];
  const sumName = PROVIDER_NAMES[r.summary];

  p.emit({ type: 'workflow', status: `⚔️ 正方 ${proName} 論述中...` });
  p.emit({ type: 'role', provider: r.pro, role: 'pro', label: '正方' });
  const proResp = await runOne(p, r.pro, PROMPTS.debate.pro(p.text));

  p.emit({ type: 'workflow', status: `⚔️ 反方 ${conName} 反駁中...` });
  p.emit({ type: 'role', provider: r.con, role: 'con', label: '反方' });
  const conResp = await runOne(p, r.con, PROMPTS.debate.con(p.text, proResp));

  p.emit({ type: 'workflow', status: `⚔️ 判官 ${judgeName} 評析中...` });
  p.emit({ type: 'role', provider: r.judge, role: 'judge', label: '判官' });
  const judgeResp = await runOne(
    p,
    r.judge,
    PROMPTS.debate.judge(p.text, proResp, conResp),
  );

  p.emit({ type: 'workflow', status: `⚔️ ${sumName} 歸納總結中...` });
  p.emit({ type: 'role', provider: r.summary, role: 'summary', label: '總結' });
  await runOne(
    p,
    r.summary,
    PROMPTS.debate.summary(p.text, proResp, conResp, judgeResp),
  );

  p.emit({ type: 'workflow', status: '' });
}

async function runConsult(
  p: OrchestratorParams,
  r: ConsultRoles,
): Promise<void> {
  const firstName = PROVIDER_NAMES[r.first];
  const secondName = PROVIDER_NAMES[r.second];
  const reviewerName = PROVIDER_NAMES[r.reviewer];
  const sumName = PROVIDER_NAMES[r.summary];

  p.emit({
    type: 'workflow',
    status: `🔍 ${firstName} 與 ${secondName} 同時回答中...`,
  });
  p.emit({ type: 'role', provider: r.first, role: 'first', label: '先答 A' });
  p.emit({ type: 'role', provider: r.second, role: 'second', label: '先答 B' });
  const [firstResp, secondResp] = await Promise.all([
    runOne(p, r.first, PROMPTS.consult.first(p.text)),
    runOne(p, r.second, PROMPTS.consult.second(p.text)),
  ]);

  p.emit({ type: 'workflow', status: `🔍 ${reviewerName} 審查中...` });
  p.emit({
    type: 'role',
    provider: r.reviewer,
    role: 'reviewer',
    label: '審查',
  });
  const reviewerResp = await runOne(
    p,
    r.reviewer,
    PROMPTS.consult.reviewer(p.text, firstResp, firstName, secondResp, secondName),
  );

  p.emit({ type: 'workflow', status: `🔍 ${sumName} 總結中...` });
  p.emit({ type: 'role', provider: r.summary, role: 'summary', label: '總結' });
  await runOne(
    p,
    r.summary,
    PROMPTS.consult.summary(
      p.text,
      firstResp,
      firstName,
      secondResp,
      secondName,
      reviewerResp,
      reviewerName,
    ),
  );

  p.emit({ type: 'workflow', status: '' });
}

async function runCoding(p: OrchestratorParams, r: CodingRoles): Promise<void> {
  const plannerName = PROVIDER_NAMES[r.planner];
  const reviewerName = PROVIDER_NAMES[r.reviewer];
  const coderName = PROVIDER_NAMES[r.coder];
  const testerName = PROVIDER_NAMES[r.tester];

  p.emit({ type: 'workflow', status: `💻 Step 1/8 — ${plannerName} 撰寫規格中...` });
  p.emit({ type: 'role', provider: r.planner, role: 'planner', label: '規劃師' });
  const spec = await runOne(p, r.planner, PROMPTS.coding.plannerSpec(p.text));

  p.emit({ type: 'workflow', status: `💻 Step 2/8 — ${reviewerName} 審查規格中...` });
  p.emit({ type: 'role', provider: r.reviewer, role: 'reviewer', label: '審查者' });
  const specReview = await runOne(
    p,
    r.reviewer,
    PROMPTS.coding.reviewerSpec(p.text, spec, plannerName),
  );

  p.emit({ type: 'workflow', status: `💻 Step 3/8 — ${coderName} 撰寫 v1 中...` });
  p.emit({ type: 'role', provider: r.coder, role: 'coder', label: 'Coder' });
  const codeV1 = await runOne(
    p,
    r.coder,
    PROMPTS.coding.coderV1(p.text, spec, plannerName, specReview, reviewerName),
  );

  p.emit({ type: 'workflow', status: `💻 Step 4/8 — ${reviewerName} Code Review 中...` });
  p.emit({ type: 'role', provider: r.reviewer, role: 'reviewer', label: 'Code Review' });
  const codeReview = await runOne(
    p,
    r.reviewer,
    PROMPTS.coding.reviewerCode(p.text, codeV1, coderName),
  );

  p.emit({ type: 'workflow', status: `💻 Step 5/8 — ${testerName} 測試分析中...` });
  p.emit({ type: 'role', provider: r.tester, role: 'tester', label: 'Tester' });
  const testReport = await runOne(
    p,
    r.tester,
    PROMPTS.coding.testerCases(p.text, codeV1, coderName),
  );

  p.emit({ type: 'workflow', status: `💻 Step 6/8 — ${coderName} 修正 → v2 中...` });
  p.emit({ type: 'role', provider: r.coder, role: 'coder', label: 'v2 修正' });
  const codeV2 = await runOne(
    p,
    r.coder,
    PROMPTS.coding.coderV2(p.text, codeV1, codeReview, reviewerName, testReport, testerName),
  );

  p.emit({ type: 'workflow', status: `💻 Step 7/8 — ${plannerName} 驗收中...` });
  p.emit({ type: 'role', provider: r.planner, role: 'planner', label: '驗收' });
  const acceptance = await runOne(
    p,
    r.planner,
    PROMPTS.coding.plannerAcceptance(p.text, codeV2, coderName, spec),
  );

  p.emit({ type: 'workflow', status: `💻 Step 8/8 — ${coderName} 最終修正中...` });
  p.emit({ type: 'role', provider: r.coder, role: 'coder', label: '最終版' });
  await runOne(
    p,
    r.coder,
    PROMPTS.coding.coderFinal(p.text, codeV2, acceptance, plannerName),
  );

  p.emit({ type: 'workflow', status: '' });
}

async function runRoundtable(
  p: OrchestratorParams,
  r: RoundtableRoles,
): Promise<void> {
  const participants: AIProvider[] = [r.first, r.second, r.third, r.fourth];
  const history: { name: string; round: number; text: string }[] = [];

  for (let round = 1; round <= 5; round++) {
    for (const participant of participants) {
      const name = PROVIDER_NAMES[participant];
      const roundLabel = ROUND_LABELS[round - 1];
      p.emit({
        type: 'workflow',
        status: `🔄 第${round}輪「${roundLabel}」— ${name} 發言中...`,
      });
      p.emit({
        type: 'role',
        provider: participant,
        role: `R${round}`,
        label: `第${round}輪`,
      });
      const prompt = PROMPTS.roundtable.buildPrompt(p.text, round, name, history);
      const response = await runOne(p, participant, prompt);
      history.push({ name, round, text: response });
    }
  }
  p.emit({ type: 'workflow', status: '' });
}
