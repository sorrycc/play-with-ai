// Stands in for a code agent's CLI in tests/duel.test.ts: it solves card 01 in its working
// directory, or does nothing, or hangs, and prints what a real one would.
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `mode ${mode}` }, { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/x/range.js' } }] } }));
if (mode === 'solve') {
  const file = 'range.js';
  writeFileSync(file, readFileSync(file, 'utf8').replace('(start, end)', '(start, end, step = 1)').replace('i += 1', 'i += step'));
}
if (mode === 'hang') setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 }, total_credits: 0.5 }));
