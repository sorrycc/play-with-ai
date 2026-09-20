// The code agents that can sit in the "code agent" seat of the code duel. Adding one is one entry
// here: how to start it headless in a directory, and how to read what it prints. Nothing else in
// the server or the page names an agent.
//
// This module is also imported by the page (for names and model lists), so it must stay plain
// data and pure functions: no node: imports.

/** Said after every task: once, qodercli answered with a plan and exited without touching a file. */
const JUST_DO_IT = '\n\n直接动手完成，不要只给计划，也不要向我提问：没有人会回答。';

const clip = (text, max = 240) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** What a tool call is about, from whichever of the usual argument names it carries. */
function toolSubject(input) {
  if (!input || typeof input !== 'object') return '';
  const file = input.file_path ?? input.path;
  // The run directory is a long temporary path nobody needs to read.
  if (typeof file === 'string') return file.split(/[\\/]/).pop();
  const other = input.command ?? input.pattern ?? input.query ?? input.description;
  return typeof other === 'string' ? clip(other, 120) : '';
}

/**
 * One line of Claude-Code-style `stream-json` output, as log entries for the page.
 * Hooks, init and tool results are noise at a booth; thoughts, words and tool calls are the show.
 */
export function readStreamJson(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON: a warning the CLI printed around the stream. Worth showing, it may be the reason it died.
    return { entries: line.trim() ? [{ kind: 'info', text: clip(line) }] : [] };
  }
  if (event?.type === 'assistant') {
    const entries = [];
    for (const part of event.message?.content ?? []) {
      if (part?.type === 'thinking' && part.thinking?.trim()) entries.push({ kind: 'think', text: clip(part.thinking) });
      else if (part?.type === 'text' && part.text?.trim()) entries.push({ kind: 'say', text: clip(part.text, 400) });
      else if (part?.type === 'tool_use') entries.push({ kind: 'tool', text: clip(`${part.name} ${toolSubject(part.input)}`) });
    }
    return { entries };
  }
  if (event?.type === 'result') {
    return {
      entries: event.is_error ? [{ kind: 'info', text: clip(event.result || event.subtype || 'error') }] : [],
      usage: {
        turns: Number(event.num_turns ?? 0),
        inputTokens: Number(event.usage?.input_tokens ?? 0),
        outputTokens: Number(event.usage?.output_tokens ?? 0),
        credits: Number(event.total_credits ?? 0),
      },
    };
  }
  return { entries: [] };
}

export const AGENTS = [
  {
    id: 'qodercli',
    name: 'Qoder CLI',
    emoji: '👾',
    /** Qoder's green, and its mark (public/agents): shown in place of the emoji wherever the page can draw it. */
    color: '#17953C',
    logo: '/agents/qodercli.svg',
    blurb: { zh: 'Qoder 的终端编程 agent，无人值守地把活干完', en: "Qoder's coding agent for the terminal, working unattended" },
    /** Looked up on the server's PATH; the seat is greyed out when it is not there. */
    bin: 'qodercli',
    /** Names as `qodercli --list-models` prints them. The first is the default. */
    models: ['Qwen3.8-Max', 'Qwen3.8-Flash', 'Kimi-K3', 'DeepSeek-Flash'],
    /** Headless, unattended, in `cwd`, leaving no session behind for the next visitor's run to find. */
    args: ({ prompt, model }) => ['-p', prompt + JUST_DO_IT, '-m', model, '--dangerously-skip-permissions', '--no-session-persistence', '-o', 'stream-json'],
    readLine: readStreamJson,
  },
];

export const findAgent = (id) => AGENTS.find((a) => a.id === id);
