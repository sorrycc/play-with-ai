// API proxy shared by the Vite dev server (vite.config.ts) and the standalone server
// (server/index.mjs). The browser never sees a key: it posts to /api/* and this module adds
// the credential from the environment.
//
//   GET  /api/config  which providers have a key
//   GET  /api/models  ZenMux chat models with prices (cached)
//   POST /api/llm     one move: a chat completion through ZenMux that must name an option id
//   POST /api/generate  free-form completion, used to write a custom algorithm's code
//   POST /api/jev     TypeSafe System One (api.typesafe.ai rejects browser origins)
//   /api/duel/*       the code duel: a person against a code agent's CLI (see duel.mjs)

import { createDuel, isLocalRequest } from './duel.mjs';
import { API_VERSION } from './version.mjs';

const ZENMUX_BASE = 'https://zenmux.ai/api/v1';
const TYPESAFE_BASE = 'https://api.typesafe.ai';
const LLM_TIMEOUT_MS = 90_000;
const JEV_TIMEOUT_MS = 30_000;
const MODELS_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 1_000_000;
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;
const OPTION_ID = /^[\w.-]{1,24}$/;
// A chess position can have up to 218 legal moves.
const MAX_OPTIONS = 220;

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('body is not JSON'), { status: 400 });
  }
}

/** Caller abort (browser went away) plus a deadline, as one signal. */
function upstreamSignal(req, timeoutMs) {
  const gone = new AbortController();
  req.on('close', () => {
    if (!req.complete) gone.abort();
  });
  return AbortSignal.any([gone.signal, AbortSignal.timeout(timeoutMs)]);
}

function firstPrice(list) {
  const v = Array.isArray(list) ? list[0]?.value : undefined;
  return typeof v === 'number' ? v : null;
}

export function createApi(env) {
  const zenmuxKey = (env.ZENMUX_API_KEY || '').trim();
  const typesafeKey = (env.TYPESAFE_API_KEY || '').trim();
  let modelsCache = null; // { at, models }
  const duel = createDuel();

  async function models() {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
    const upstream = await fetch(`${ZENMUX_BASE}/models`, { signal: AbortSignal.timeout(20_000) });
    if (!upstream.ok) throw new Error(`models http ${upstream.status}`);
    const payload = await upstream.json();
    const list = (payload.data || [])
      .filter((m) => (m.output_modalities || []).includes('text') && firstPrice(m.pricings?.prompt) !== null)
      .map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        reasoning: Boolean(m.capabilities?.reasoning),
        // USD per million tokens
        inputPrice: firstPrice(m.pricings?.prompt),
        outputPrice: firstPrice(m.pricings?.completion) ?? 0,
      }));
    modelsCache = { at: Date.now(), models: list };
    return list;
  }

  async function llm(req, res) {
    if (!zenmuxKey) return send(res, 503, { error: 'unconfigured', message: 'ZENMUX_API_KEY is not set in .env' });
    const body = await readJson(req);
    if (typeof body.model !== 'string' || !MODEL_ID.test(body.model)) {
      return send(res, 400, { error: 'bad_request', message: 'model must look like provider/name' });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return send(res, 400, { error: 'bad_request', message: 'messages required' });
    }
    const thinking = body.thinking === true;
    const optionIds = Array.isArray(body.optionIds) ? body.optionIds : [];
    if (optionIds.length > MAX_OPTIONS || optionIds.some((id) => typeof id !== 'string' || !OPTION_ID.test(id))) {
      return send(res, 400, { error: 'bad_request', message: 'optionIds must be short id strings' });
    }

    // Two ways to get one option id back, probed 2026-09-19 on DeepSeek V4.1 Flash, Qwen 3.8 Flash,
    // Claude Haiku 4.5, GPT-5.6 Luna and Gemini 3.7 Flash:
    //
    //   forced function call, the argument an enum of the legal ids. Works on all five with
    //   reasoning off, and is the only thing that stops Claude answering in 400 tokens of prose.
    //   DeepSeek and Qwen reject a forced call while thinking ("Thinking mode does not support
    //   this tool_choice").
    //
    //   JSON mode, used when thinking is on, and as the retry when a model rejects the call.
    //
    // The token cap leaves room for Gemini, which cannot switch thinking off: at 120 tokens it ran
    // out before writing an answer.
    const base = { model: body.model, messages: body.messages, temperature: typeof body.temperature === 'number' ? body.temperature : 0.2, reasoning: { enabled: thinking } };
    const asJson = { ...base, max_tokens: thinking ? 4000 : 800, response_format: { type: 'json_object' } };
    const asCall = {
      ...base,
      max_tokens: 800,
      tools: [
        {
          type: 'function',
          function: {
            name: 'choose_option',
            description: 'Choose one option by its id.',
            parameters: { type: 'object', properties: { option_id: { type: 'string', enum: optionIds } }, required: ['option_id'], additionalProperties: false },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'choose_option' } },
    };
    const useCall = !thinking && optionIds.length > 0;

    const started = Date.now();
    const signal = upstreamSignal(req, LLM_TIMEOUT_MS);
    const ask = (payload) =>
      fetch(`${ZENMUX_BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${zenmuxKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    let upstream;
    try {
      upstream = await ask(useCall ? asCall : asJson);
      // A model that does not take a forced call says so with a 400; JSON mode is the way in then.
      if (useCall && upstream.status === 400) {
        await upstream.body?.cancel().catch(() => {});
        upstream = await ask(asJson);
      }
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      return send(res, timedOut ? 504 : 502, { error: timedOut ? 'timeout' : 'unreachable', message: String(error?.name || error) });
    }
    const text = await upstream.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (!upstream.ok || !json) {
      const message = json?.error?.message || json?.message || text.slice(0, 200) || `http ${upstream.status}`;
      return send(res, upstream.ok ? 502 : upstream.status, { error: 'upstream', message });
    }
    const message = json.choices?.[0]?.message;
    // A function call's arguments are already the JSON the page expects: {"option_id": "..."}.
    const call = message?.tool_calls?.find((c) => c?.function?.name === 'choose_option');
    const content = typeof call?.function?.arguments === 'string' ? call.function.arguments : typeof message?.content === 'string' ? message.content : '';
    send(res, 200, {
      content,
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      inputTokens: Number(json.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json.usage?.completion_tokens ?? 0),
      upstreamMs: Date.now() - started,
    });
  }

  /** A plain completion with room for a few hundred lines of code. No tools, no JSON mode. */
  async function generate(req, res) {
    if (!zenmuxKey) return send(res, 503, { error: 'unconfigured', message: 'ZENMUX_API_KEY is not set in .env' });
    const body = await readJson(req);
    if (typeof body.model !== 'string' || !MODEL_ID.test(body.model)) {
      return send(res, 400, { error: 'bad_request', message: 'model must look like provider/name' });
    }
    const ok = Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 8 && body.messages.every((m) => typeof m?.content === 'string' && ['system', 'user', 'assistant'].includes(m?.role));
    if (!ok) return send(res, 400, { error: 'bad_request', message: 'messages must be 1-8 {role, content} entries' });
    let upstream;
    try {
      upstream = await fetch(`${ZENMUX_BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${zenmuxKey}`, 'content-type': 'application/json' },
        // Reasoning stays off: the flash models write this much code well without it, in a few seconds.
        body: JSON.stringify({ model: body.model, messages: body.messages, max_tokens: 6000, temperature: 0.4, reasoning: { enabled: false } }),
        signal: upstreamSignal(req, LLM_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      return send(res, timedOut ? 504 : 502, { error: timedOut ? 'timeout' : 'unreachable', message: String(error?.name || error) });
    }
    const text = await upstream.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (!upstream.ok || !json) {
      const message = json?.error?.message || json?.message || text.slice(0, 200) || `http ${upstream.status}`;
      return send(res, upstream.ok ? 502 : upstream.status, { error: 'upstream', message });
    }
    const message = json.choices?.[0]?.message;
    send(res, 200, {
      content: typeof message?.content === 'string' ? message.content : '',
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      inputTokens: Number(json.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json.usage?.completion_tokens ?? 0),
    });
  }

  async function jev(req, res) {
    if (!typesafeKey) return send(res, 503, { error: 'unconfigured', message: 'TYPESAFE_API_KEY is not set in .env' });
    const body = await readJson(req);
    let upstream;
    try {
      upstream = await fetch(`${TYPESAFE_BASE}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${typesafeKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: upstreamSignal(req, JEV_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      return send(res, timedOut ? 504 : 502, { error: timedOut ? 'timeout' : 'unreachable', message: String(error?.name || error) });
    }
    const text = await upstream.text();
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) headers['Retry-After'] = retryAfter;
    res.writeHead(upstream.status, headers);
    res.end(text);
  }

  /** Returns true when the request was an API route (and has been answered). */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        send(res, 200, { zenmux: Boolean(zenmuxKey), jev: Boolean(typesafeKey), agents: await duel.availableAgents(), version: API_VERSION });
      } else if (url.pathname === '/api/models' && req.method === 'GET') {
        send(res, 200, { models: await models() });
      } else if (url.pathname === '/api/llm' && req.method === 'POST') {
        await llm(req, res);
      } else if (url.pathname === '/api/generate' && req.method === 'POST') {
        await generate(req, res);
      } else if (url.pathname === '/api/jev' && req.method === 'POST') {
        await jev(req, res);
      } else if (url.pathname.startsWith('/api/duel/')) {
        const route = url.pathname.slice('/api/duel/'.length);
        if (!isLocalRequest(req.headers)) send(res, 403, { error: 'forbidden', message: 'The code duel only answers a page served from this machine.' });
        else if (req.method === 'GET' && route === 'cards') send(res, 200, await duel.cards());
        else if (req.method === 'GET' && route === 'state') send(res, 200, duel.state(url.searchParams));
        else if (req.method === 'POST' && ['start', 'go', 'test', 'submit', 'stop'].includes(route)) send(res, 200, await duel[route](await readJson(req)));
        else send(res, 404, { error: 'not_found', message: 'Unknown API route.' });
      } else {
        send(res, 404, { error: 'not_found', message: 'Unknown API route.' });
      }
    } catch (error) {
      if (!res.headersSent) send(res, error?.status || 500, { error: 'server_error', message: String(error?.message || error) });
      else res.end();
    }
    return true;
  };
}
