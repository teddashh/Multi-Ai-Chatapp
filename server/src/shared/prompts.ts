// Prompt wrappers for sequential modes. Two language variants — picked at
// orchestrate time based on the user's language preference.

export type Lang = 'zh-TW' | 'en';

export interface PromptSet {
  debate: {
    pro: (q: string) => string;
    con: (q: string, pro: string) => string;
    judge: (q: string, pro: string, con: string) => string;
    summary: (q: string, pro: string, con: string, judge: string) => string;
  };
  consult: {
    first: (q: string) => string;
    second: (q: string) => string;
    reviewer: (
      q: string,
      a: string,
      aName: string,
      b: string,
      bName: string,
    ) => string;
    summary: (
      q: string,
      a: string,
      aName: string,
      b: string,
      bName: string,
      r: string,
      rName: string,
    ) => string;
  };
  roundtable: {
    buildPrompt: (
      question: string,
      round: number,
      speakerName: string,
      history: { name: string; round: number; text: string }[],
    ) => string;
  };
  coding: {
    plannerSpec: (q: string) => string;
    reviewerSpec: (q: string, spec: string, plannerName: string) => string;
    coderV1: (
      q: string,
      spec: string,
      plannerName: string,
      review: string,
      reviewerName: string,
    ) => string;
    reviewerCode: (q: string, code: string, coderName: string) => string;
    testerCases: (q: string, code: string, coderName: string) => string;
    coderV2: (
      q: string,
      v1: string,
      review: string,
      reviewerName: string,
      tests: string,
      testerName: string,
    ) => string;
    plannerAcceptance: (
      q: string,
      v2: string,
      coderName: string,
      spec: string,
    ) => string;
    coderFinal: (
      q: string,
      v2: string,
      acceptance: string,
      plannerName: string,
    ) => string;
  };
}

const PROMPTS_ZH: PromptSet = {
  debate: {
    pro: (q) =>
      `請從支持、贊同的角度回答以下問題，提出你最強的論點：\n\n${q}`,
    con: (q, pro) =>
      `使用者問了：「${q}」\n\n正方提出了以下觀點：\n${pro}\n\n請從反方的角度，針對以上正方觀點提出反駁，指出其論點的弱點和盲點。`,
    judge: (q, pro, con) =>
      `使用者問了：「${q}」\n\n正方觀點：\n${pro}\n\n反方觀點：\n${con}\n\n你是判官。請不要選邊站，而是：\n1. 分別評論正反兩方論點的邏輯強度與弱點\n2. 指出雙方論述中被忽略的盲點或隱含假設\n3. 列出哪些爭議是真分歧、哪些只是語義或角度差異\n4. 給出這場辯論目前的焦點在哪\n\n你的工作不是下結論，而是把論點的結構梳理清楚，讓後面的總結方能站在更高的視角收斂。`,
    summary: (q, pro, con, judge) =>
      `使用者問了：「${q}」\n\n正方觀點：\n${pro}\n\n反方觀點：\n${con}\n\n判官評論：\n${judge}\n\n請綜合正反雙方的論點與判官的評析，指出各自的優缺點，並補上你自己的觀點和結論。`,
  },
  consult: {
    first: (q) => q,
    second: (q) => q,
    reviewer: (q, a, aName, b, bName) =>
      `使用者問了：「${q}」\n\n${aName} 的回答：\n${a}\n\n${bName} 的回答：\n${b}\n\n請檢查兩人說的對不對，對比他們的差異，指出誰的觀點更完整，有沒有遺漏或錯誤。也請你做些研究，補上你自己的答案。`,
    summary: (q, a, aName, b, bName, r, rName) =>
      `使用者問了：「${q}」\n\n${aName} 的回答：\n${a}\n\n${bName} 的回答：\n${b}\n\n${rName} 的審查：\n${r}\n\n請綜合以上三位的回答，找出共識與分歧，總結他們的說法，並做點研究補上你自己的最終答案。`,
  },
  roundtable: {
    buildPrompt: (question, round, speakerName, history) => {
      const roundInstructions: Record<number, string> = {
        1: `你是 ${speakerName}。這是一場五輪辯證，四位 AI 輪流發言，目標是「真理越辯越明」。\n\n【第一輪・開場立論】\n請針對以下議題，提出你獨特的觀點和立場。選一個你最有信心的角度深入闡述，不要試圖面面俱到。\n\n要求：有明確立場、有具體論據、有邏輯推演。請精煉你的論點（建議 300-500 字）。`,
        2: `你是 ${speakerName}。\n\n【第二輪・交叉質疑】\n請仔細讀完其他人第一輪的論點，然後：\n1. 指出你認為最有問題的 1-2 個論點，具體說明為什麼不同意\n2. 承認哪些點你覺得說得有道理（不能跳過這步）\n3. 提出一個其他人都沒提到的新角度\n\n不要全盤否定，也不要和稀泥。要有建設性的衝突。`,
        3: `你是 ${speakerName}。\n\n【第三輪・攻防深化】\n你的論點在第二輪被質疑了。請：\n1. 針對被質疑的部分做出具體回應（不能迴避）\n2. 如果你被說服了某些點，坦承修正你的立場 — 改變想法不是弱點，是思考能力的展現\n3. 在修正後的基礎上，深化你最核心的論點\n\n目標：讓你的論點更精準、更有力。`,
        4: `你是 ${speakerName}。\n\n【第四輪・核心收斂】\n經過三輪辯論，請做一次結構性的梳理：\n1. 列出目前四方的共識（哪些點大家其實是同意的？）\n2. 列出真正的核心分歧（哪些是根本性的不同意見？）\n3. 辨別假分歧（哪些爭論其實只是語義差異或角度不同？）\n4. 對核心分歧，說明你為什麼堅持你的立場 — 不要為了和諧而放棄你認為對的事\n\n目標：把辯論聚焦到真正重要的問題上。`,
        5: `你是 ${speakerName}。\n\n【最終輪・真理浮現】\n這是最後一輪。請給出你的最終結論：\n1. 經過四輪辯論，你的立場改變了多少？具體哪些觀點改變了你的想法？\n2. 你認為這個議題的「真理」在哪裡？（可以是多元的）\n3. 還有哪些問題是這場辯論沒能解決的？\n\n坦誠 > 正確。展現你的思考過程。`,
      };
      let prompt = `${roundInstructions[round]}\n\n議題：「${question}」`;
      if (history.length > 0) {
        const historyText = history
          .map((h) => `【第${h.round}輪・${h.name}】\n${h.text}`)
          .join('\n\n---\n\n');
        prompt += `\n\n── 以下是目前的辯論記錄 ──\n\n${historyText}`;
      }
      return prompt;
    },
  },
  coding: {
    plannerSpec: (q) =>
      `你是軟體架構規劃師。請針對以下需求，寫出完整的實作計畫：\n1. 需求分析與邊界條件\n2. 技術選型與理由\n3. 檔案結構\n4. 每個模組的職責與介面定義\n5. 關鍵演算法的偽代碼\n6. 可能的 edge cases\n\n計畫要完整到「不需要再問問題就能直接寫 code」。\n\n需求：${q}`,
    reviewerSpec: (q, spec, plannerName) =>
      `你是嚴格的技術審查者。${plannerName} 針對以下需求寫了一份實作計畫：\n\n需求：${q}\n\n計畫：\n${spec}\n\n請嚴格審查：\n1. 邏輯漏洞？\n2. 漏掉的 edge cases？\n3. 安全性問題？\n4. 架構設計是否合理？\n5. 有沒有更好的做法？\n\n不要當好人，你的工作就是挑毛病。同時也指出計畫中做得好的部分。`,
    coderV1: (q, spec, plannerName, review, reviewerName) =>
      `你是資深工程師。請根據以下規格和審查意見，寫出第一版完整實作代碼。\n\n需求：${q}\n\n${plannerName} 的規格：\n${spec}\n\n${reviewerName} 的審查意見：\n${review}\n\n要求：\n1. 處理審查中提到的所有問題\n2. 補上錯誤處理和 edge cases\n3. 如果規格和審查有矛盾，用你的專業判斷選擇\n\n這是第一版，後面還有 code review 和測試機會，所以先完成核心功能。`,
    reviewerCode: (q, code, coderName) =>
      `你是嚴格的 Code Reviewer。${coderName} 根據規格寫了第一版代碼。\n\n原始需求：${q}\n\n${coderName} 的代碼（v1）：\n${code}\n\n請做完整的 code review：\n1. 有沒有 bug 或邏輯錯誤？\n2. 有沒有漏掉的 edge cases？\n3. 程式碼品質：命名、結構、可讀性\n4. 效能問題？\n5. 安全性問題？\n\n列出每個問題的嚴重程度（Critical / Major / Minor）和具體修正建議。`,
    testerCases: (q, code, coderName) =>
      `你是嚴格的測試工程師（QA）。${coderName} 寫了第一版代碼，請你從測試視角挑問題。\n\n原始需求：${q}\n\n${coderName} 的代碼（v1）：\n${code}\n\n請：\n1. 列出關鍵的測試案例（正常路徑、邊界條件、異常輸入、併發/狀態問題）\n2. 推演每個測試案例在這份 code 上會不會 pass，如果會失敗，具體說明為什麼\n3. 找出 code review 視角不容易看出、但跑測試才會爆的 bug（race condition、資源洩漏、邊界溢位等）\n4. 如果適用，給出可直接使用的測試 code（unit test 或 integration test）\n\n目標：用測試的角度補強 code review 漏掉的問題。`,
    coderV2: (q, v1, review, reviewerName, tests, testerName) =>
      `你是資深工程師。${reviewerName} 做了 code review，${testerName} 做了測試分析。\n\n原始需求：${q}\n\n你的 v1 代碼：\n${v1}\n\n${reviewerName} 的 code review：\n${review}\n\n${testerName} 的測試報告：\n${tests}\n\n請根據 review 與測試發現的問題修正代碼，產出 v2。要求：\n1. 處理所有 Critical 和 Major 問題\n2. 確保代碼能通過 Tester 列出的所有測試案例\n3. 在關鍵修改處加上簡短註解說明為什麼改\n4. 如果你不同意某個 review 或測試意見，說明理由\n\n輸出完整的 v2 代碼。`,
    plannerAcceptance: (q, v2, coderName, spec) =>
      `你是軟體架構規劃師，同時也是這個需求的提出者。${coderName} 已經根據規格、code review 和測試報告修正了代碼。\n\n原始需求：${q}\n\n你當初的規格：\n${spec}\n\n${coderName} 的 v2 代碼：\n${v2}\n\n請做驗收測試：\n1. v2 是否完整實現了原始需求的每一個功能點？\n2. 是否符合你的架構設計？\n3. 有沒有偏離規格的地方？\n4. 還有什麼需要調整的？\n\n如果都通過，明確說「驗收通過」。如果有問題，列出需要修正的項目。`,
    coderFinal: (q, v2, acceptance, plannerName) =>
      `你是資深工程師。${plannerName} 對你的 v2 代碼做了驗收測試。\n\n原始需求：${q}\n\n你的 v2 代碼：\n${v2}\n\n${plannerName} 的驗收結果：\n${acceptance}\n\n如果驗收通過，輸出最終版代碼（可做最後的 polish）。\n如果有需要修正的項目，處理後輸出最終版。\n\n這是最終版，請確保：\n1. 所有驗收意見已處理\n2. 代碼可以直接使用\n3. 必要的文件或使用說明已包含`,
  },
};

const PROMPTS_EN: PromptSet = {
  debate: {
    pro: (q) =>
      `Answer the following question from a supportive, in-favor angle. Make your strongest case:\n\n${q}`,
    con: (q, pro) =>
      `The user asked: "${q}"\n\nThe pro side argued:\n${pro}\n\nFrom the opposing side, rebut the pro arguments above. Identify their weaknesses and blind spots.`,
    judge: (q, pro, con) =>
      `The user asked: "${q}"\n\nPro:\n${pro}\n\nCon:\n${con}\n\nYou are the judge. Don't pick a side. Instead:\n1. Evaluate the logical strength and weakness of each side's arguments\n2. Surface blind spots or hidden assumptions both sides missed\n3. Distinguish real disagreements from semantic or framing differences\n4. State where the debate's true focus currently lies\n\nYour job is not to conclude, but to clarify the structure of the arguments so the summarizer can converge from a higher vantage.`,
    summary: (q, pro, con, judge) =>
      `The user asked: "${q}"\n\nPro:\n${pro}\n\nCon:\n${con}\n\nJudge's analysis:\n${judge}\n\nSynthesize the arguments from both sides plus the judge's analysis. Call out the strengths and weaknesses of each, then add your own view and a final conclusion.`,
  },
  consult: {
    first: (q) => q,
    second: (q) => q,
    reviewer: (q, a, aName, b, bName) =>
      `The user asked: "${q}"\n\n${aName}'s answer:\n${a}\n\n${bName}'s answer:\n${b}\n\nCheck whether each is correct, compare their differences, and point out which view is more complete and any errors or gaps. Also do your own research and contribute your own answer.`,
    summary: (q, a, aName, b, bName, r, rName) =>
      `The user asked: "${q}"\n\n${aName}'s answer:\n${a}\n\n${bName}'s answer:\n${b}\n\n${rName}'s review:\n${r}\n\nSynthesize the three answers above. Identify consensus and disagreement, summarize their positions, then add your own research-backed final answer.`,
  },
  roundtable: {
    buildPrompt: (question, round, speakerName, history) => {
      const roundInstructions: Record<number, string> = {
        1: `You are ${speakerName}. This is a 5-round dialectic with four AI speakers, aimed at "truth emerging through debate."\n\n[Round 1 — Opening Argument]\nFor the topic below, present your unique view and stance. Pick the angle you're most confident in and develop it deeply — don't try to cover everything.\n\nRequirements: a clear stance, concrete evidence, a logical chain. Keep it sharp (300-500 words).`,
        2: `You are ${speakerName}.\n\n[Round 2 — Cross-Examination]\nRead the others' Round 1 arguments carefully, then:\n1. Name the 1-2 arguments you find most problematic and explain why concretely\n2. Acknowledge the points you think are valid (don't skip this)\n3. Raise a new angle no one else has mentioned\n\nDon't reject everything, and don't paper over differences. Conflict should be constructive.`,
        3: `You are ${speakerName}.\n\n[Round 3 — Deepening Attack and Defense]\nYour arguments were challenged in Round 2. Now:\n1. Respond concretely to each challenge (no dodging)\n2. If you've been convinced on some points, openly revise your stance — changing your mind isn't weakness, it's the mark of real thinking\n3. On the revised foundation, deepen your core argument\n\nGoal: sharper, stronger arguments.`,
        4: `You are ${speakerName}.\n\n[Round 4 — Convergence on the Core]\nAfter three rounds, run a structural pass:\n1. List the points the four sides actually agree on\n2. List the genuine core disagreements\n3. Identify pseudo-disagreements (semantic or framing differences masquerading as substance)\n4. On the genuine disagreements, explain why you hold your stance — don't trade what you think is right for harmony\n\nGoal: focus the debate on what truly matters.`,
        5: `You are ${speakerName}.\n\n[Final Round — Truth Emerges]\nThis is the last round. Give your final conclusion:\n1. How much has your stance shifted across the four rounds? Which specific arguments changed your mind?\n2. Where do you think the "truth" of this issue lies? (It can be plural.)\n3. Which questions did this debate fail to resolve?\n\nHonesty > correctness. Show your reasoning.`,
      };
      let prompt = `${roundInstructions[round]}\n\nTopic: "${question}"`;
      if (history.length > 0) {
        const historyText = history
          .map((h) => `[Round ${h.round} — ${h.name}]\n${h.text}`)
          .join('\n\n---\n\n');
        prompt += `\n\n── Debate transcript so far ──\n\n${historyText}`;
      }
      return prompt;
    },
  },
  coding: {
    plannerSpec: (q) =>
      `You are a software architect. For the requirement below, write a complete implementation plan:\n1. Requirement analysis and boundary conditions\n2. Tech choices and rationale\n3. File structure\n4. Each module's responsibility and interface\n5. Pseudocode for the key algorithms\n6. Likely edge cases\n\nThe plan should be complete enough that "no questions are needed before coding."\n\nRequirement: ${q}`,
    reviewerSpec: (q, spec, plannerName) =>
      `You are a strict technical reviewer. ${plannerName} wrote the following implementation plan for this requirement:\n\nRequirement: ${q}\n\nPlan:\n${spec}\n\nReview rigorously:\n1. Logical gaps?\n2. Missing edge cases?\n3. Security issues?\n4. Is the architecture sound?\n5. Any better approaches?\n\nDon't be polite — your job is to find faults. Also call out what the plan does well.`,
    coderV1: (q, spec, plannerName, review, reviewerName) =>
      `You are a senior engineer. Based on the spec and the review below, write the complete v1 implementation.\n\nRequirement: ${q}\n\n${plannerName}'s spec:\n${spec}\n\n${reviewerName}'s review:\n${review}\n\nRequirements:\n1. Address every issue raised in the review\n2. Add error handling and edge cases\n3. If the spec and review conflict, exercise your judgment\n\nThis is v1 — code review and tests come after, so focus on completing the core functionality first.`,
    reviewerCode: (q, code, coderName) =>
      `You are a strict code reviewer. ${coderName} wrote a v1 against the spec.\n\nOriginal requirement: ${q}\n\n${coderName}'s v1 code:\n${code}\n\nDo a complete code review:\n1. Bugs or logic errors?\n2. Missed edge cases?\n3. Code quality: naming, structure, readability\n4. Performance issues?\n5. Security issues?\n\nFor each issue, give severity (Critical / Major / Minor) and a concrete fix suggestion.`,
    testerCases: (q, code, coderName) =>
      `You are a strict QA engineer. ${coderName} wrote v1 — surface problems from a testing perspective.\n\nOriginal requirement: ${q}\n\n${coderName}'s v1 code:\n${code}\n\nPlease:\n1. Enumerate the key test cases (happy path, boundaries, abnormal inputs, concurrency / state issues)\n2. Walk through each case against this code and tell whether it passes; if it fails, explain why concretely\n3. Surface bugs that code review tends to miss but testing exposes (race conditions, resource leaks, off-by-one, etc.)\n4. Where applicable, provide ready-to-run test code (unit or integration)\n\nGoal: catch what the code review missed.`,
    coderV2: (q, v1, review, reviewerName, tests, testerName) =>
      `You are a senior engineer. ${reviewerName} did a code review and ${testerName} did a test analysis.\n\nOriginal requirement: ${q}\n\nYour v1 code:\n${v1}\n\n${reviewerName}'s code review:\n${review}\n\n${testerName}'s test report:\n${tests}\n\nFix the code based on the review and test findings, producing v2. Requirements:\n1. Address every Critical and Major issue\n2. Ensure the code passes every test case the tester listed\n3. Add brief comments at the key change sites explaining the why\n4. If you disagree with a review or test point, say why\n\nOutput the complete v2 code.`,
    plannerAcceptance: (q, v2, coderName, spec) =>
      `You are the software architect and the requirement owner. ${coderName} has revised the code based on the spec, code review, and test report.\n\nOriginal requirement: ${q}\n\nYour original spec:\n${spec}\n\n${coderName}'s v2 code:\n${v2}\n\nDo acceptance testing:\n1. Does v2 fully implement every functional point of the original requirement?\n2. Does it match your architecture?\n3. Are there deviations from the spec?\n4. What still needs adjusting?\n\nIf everything passes, say "Accepted." If there are issues, list them.`,
    coderFinal: (q, v2, acceptance, plannerName) =>
      `You are a senior engineer. ${plannerName} did acceptance testing on your v2.\n\nOriginal requirement: ${q}\n\nYour v2 code:\n${v2}\n\n${plannerName}'s acceptance result:\n${acceptance}\n\nIf accepted, output the final version (last polish OK).\nIf there are required fixes, address them and output the final version.\n\nThis is the final version. Make sure:\n1. Every acceptance comment is addressed\n2. The code is ready to use as-is\n3. Any necessary docs or usage notes are included`,
  },
};

export function getPrompts(lang: Lang): PromptSet {
  return lang === 'en' ? PROMPTS_EN : PROMPTS_ZH;
}

// Legacy default — kept so any leftover imports of `PROMPTS` keep compiling
// against the Chinese set. New code should use `getPrompts(lang)`.
export const PROMPTS = PROMPTS_ZH;

export const PROVIDER_NAMES: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
};
