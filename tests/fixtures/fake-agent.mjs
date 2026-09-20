// Stands in for a code agent's CLI in tests/duel.test.ts: it solves card 01 in its working
// directory, or does nothing, or hangs, or leaves a helper of its own behind, and prints what a
// real one would.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `mode ${mode}` }, { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/x/range.js' } }] } }));
// What a settings check hears: words, and no work.
if (mode === 'say') console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }));
if (mode === 'refuse') {
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'not logged in' }));
  process.exit(1);
}
if (mode === 'solve') {
  const file = 'range.js';
  writeFileSync(file, readFileSync(file, 'utf8').replace('(start, end)', '(start, end, step = 1)').replace('i += 1', 'i += step'));
}
if (mode === 'spawn') {
  // A helper in the agent's own process group, of the kind a real CLI starts and does not wait for.
  const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  writeFileSync('helper.pid', String(helper.pid));
}
if (mode === 'hang' || mode === 'spawn') setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 }, total_credits: 0.5 }));
