export type AIProvider = 'chatgpt' | 'claude' | 'gemini' | 'grok';

export type Tier = 'standard' | 'pro' | 'super';

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
  | { type: 'done'; provider: AIProvider; text: string }
  | { type: 'error'; provider?: AIProvider; message: string }
  | { type: 'session'; sessionId: string; isNew: boolean }
  | { type: 'finish' };
