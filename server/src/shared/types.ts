export type AIProvider = 'chatgpt' | 'claude' | 'gemini' | 'grok';

export type Tier = 'free' | 'standard' | 'pro' | 'super' | 'admin';

export type ChatMode = 'free' | 'debate' | 'consult' | 'coding' | 'roundtable';

export interface DebateRoles {
  pro: AIProvider;
  con: AIProvider;
  judge: AIProvider;
  summary: AIProvider;
}

export interface ConsultRoles {
  first: AIProvider;
  second: AIProvider;
  reviewer: AIProvider;
  summary: AIProvider;
}

export interface CodingRoles {
  planner: AIProvider;
  reviewer: AIProvider;
  coder: AIProvider;
  tester: AIProvider;
}

export interface RoundtableRoles {
  first: AIProvider;
  second: AIProvider;
  third: AIProvider;
  fourth: AIProvider;
}

export type ModeRoles = DebateRoles | ConsultRoles | CodingRoles | RoundtableRoles;

export interface ChatRequest {
  text: string;
  mode: ChatMode;
  roles?: ModeRoles;
}

// SSE event payloads (server → client)
export type SSEEvent =
  | { type: 'workflow'; status: string }
  | { type: 'role'; provider: AIProvider; role: string; label: string }
  | { type: 'chunk'; provider: AIProvider; text: string }
  | {
      type: 'done';
      provider: AIProvider;
      text: string;
      messageId?: number;
      // Phase 8: provenance — which stage answered, and the actual model
      // SKU that answered. Carried through to the chat_messages row so
      // admins can see "Claude · API · claude-opus-4-7" under each
      // bubble. Regular users never see these values.
      answeredStage?: string;
      answeredModel?: string;
    }
  | { type: 'error'; provider?: AIProvider; message: string }
  | { type: 'session'; sessionId: string; isNew: boolean }
  // Fallback chain triggered — UI clears any partial bubble for this provider
  // and shows the bridging message ("換個方式思考一下…") until the next chunk
  // arrives. We deliberately do NOT tell the user that a different model is
  // taking over; the message stays in-character.
  | { type: 'fallback_notice'; provider: AIProvider; message: string }
  // Auto-generated session title is ready (NVIDIA NIM, fired once on the
  // first turn of a new session). Client should update the sidebar entry
  // for `sessionId` to show `title` instead of the heuristic placeholder.
  | { type: 'session_title'; sessionId: string; title: string }
  | { type: 'finish' };
