export interface AgentLogEntry {
  kind: 'think' | 'say' | 'tool' | 'info';
  text: string;
}
export interface AgentUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
}
export interface AgentInfo {
  id: string;
  name: string;
  emoji: string;
  color: string;
  /** URL of a one-colour SVG mark, drawn in `color`. */
  logo?: string;
  /** One line about the product, under its name on the setup page. */
  blurb: { zh: string; en: string };
  bin: string;
  models: string[];
  args(run: { prompt: string; model: string }): string[];
  readLine(line: string): { entries: AgentLogEntry[]; usage?: AgentUsage };
}
export const AGENTS: AgentInfo[];
export function findAgent(id: string | undefined): AgentInfo | undefined;
export function readStreamJson(line: string): { entries: AgentLogEntry[]; usage?: AgentUsage };
