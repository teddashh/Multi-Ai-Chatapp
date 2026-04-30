export type AIProvider = 'chatgpt' | 'claude' | 'gemini' | 'grok';
export type Tier = 'free' | 'standard' | 'pro' | 'super' | 'admin';
export type ChatMode =
  | 'free'
  | 'debate'
  | 'consult'
  | 'coding'
  | 'roundtable'
  | 'personal'
  | 'profession'
  | 'reasoning'
  | 'image';

export type ModeGroup = 'multi' | 'agent';

export const MULTI_MODES: ChatMode[] = ['free', 'debate', 'consult', 'coding', 'roundtable'];
export const AGENT_MODES: ChatMode[] = ['personal', 'profession', 'reasoning', 'image'];

export function modeGroupOf(mode: ChatMode): ModeGroup {
  return AGENT_MODES.includes(mode) ? 'agent' : 'multi';
}

// Modes that are visible in the dropdown but not yet implemented on
// the backend — clicking them shows "Coming soon".
export const COMING_SOON_MODES: ChatMode[] = ['image'];

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

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'pdf' | 'text' | 'other';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  provider?: AIProvider;
  modeRole?: string;
  content: string;
  timestamp: number;
  attachments?: MessageAttachment[];
  // Admin-only provenance: which orchestrator stage answered ('cli' /
  // 'claude_api' / 'openrouter' / 'nvidia' / etc) and the actual model
  // SKU that ran. Server returns these only to admin users; regular
  // users always see undefined.
  answeredStage?: string;
  answeredModel?: string;
  // What the user originally picked from the dropdown — admin badge
  // shows an arrow ("X → Y") when it differs from answeredModel.
  requestedModel?: string;
}

export type SSEEvent =
  | { type: 'workflow'; status: string }
  | { type: 'role'; provider: AIProvider; role: string; label: string }
  | { type: 'chunk'; provider: AIProvider; text: string }
  | {
      type: 'done';
      provider: AIProvider;
      text: string;
      messageId?: number;
      answeredStage?: string;
      answeredModel?: string;
      requestedModel?: string;
    }
  | { type: 'error'; provider?: AIProvider; message: string }
  | { type: 'session'; sessionId: string; isNew: boolean }
  | { type: 'fallback_notice'; provider: AIProvider; message: string }
  | { type: 'session_title'; sessionId: string; title: string }
  | { type: 'finish' };
