/**
 * mobe3-technical-query — Analyze the mobe3 codebase via Claude CLI.
 *
 * This is a server-side tool used by the `mobe3-technical` agent so the
 * workflow is independent of OpenClaw bindings/routes.
 */

const os = require('os');
const path = require('path');
const { claudeStream, claudeQuery } = require('../src/claudeHelper');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PREPROCESS_TIMEOUT_MS = 30 * 1000;
const MAX_CONCURRENT = 3;

const MOBE_DIR = process.env.MOBE3_WORKDIR || path.join(os.homedir(), 'Projects', 'mobe3Full');

const SYSTEM_PROMPT = [
  'You are the mobe3 technical analysis agent.',
  'Your job is to analyze and explain the existing mobe3 codebase.',
  'Use evidence from files/tools and provide concise, accurate answers.',
  'Do not invent code changes unless explicitly requested.',
].join(' ');

const PREPROCESSING_PROMPT = [
  'You are a preprocessing parser.',
  'Return ONLY valid JSON with this shape:',
  '{ "prompt": "cleaned prompt", "short_prompt": "3-6 word topic label" }',
  'Do not include markdown fences.',
].join('\n');

let running = 0;

function maybeParseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

async function preprocess(rawPrompt) {
  const result = await claudeQuery(rawPrompt, {
    cwd: os.tmpdir(),
    systemPrompt: PREPROCESSING_PROMPT,
    timeoutMs: PREPROCESS_TIMEOUT_MS,
  });

  const parsed = maybeParseJSON(result.markdown) || { prompt: rawPrompt, short_prompt: null };
  return {
    prompt: parsed.prompt || rawPrompt,
    shortPrompt: parsed.short_prompt || null,
  };
}

module.exports = {
  name: 'mobe3-technical-query',
  description: 'Analyze the mobe3Full codebase with Claude CLI and return a technical answer.',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'User question/task for mobe3 analysis.',
      },
      preprocess: {
        type: 'boolean',
        description: 'If true, preprocesses prompt to remove delivery/meta instructions.',
        default: true,
      },
      threadContext: {
        type: 'string',
        description: 'Optional prior thread context to prepend.',
      },
    },
    required: ['prompt'],
  },

  async execute(input) {
    const rawPrompt = String(input.prompt || '').trim();
    if (!rawPrompt) {
      return { output: 'Missing prompt', isError: true };
    }

    if (running >= MAX_CONCURRENT) {
      return { output: `Too many concurrent requests (${MAX_CONCURRENT})`, isError: true };
    }

    // Tool-owned timeout: ignore caller-provided timeoutMs from tool input.
    const timeoutMs = DEFAULT_TIMEOUT_MS;
    const preprocessEnabled = input.preprocess !== false;
    const threadContext = typeof input.threadContext === 'string' ? input.threadContext.trim() : '';

    running++;
    try {
      const pre = preprocessEnabled
        ? await preprocess(rawPrompt)
        : { prompt: rawPrompt, shortPrompt: null };

      const fullPrompt = threadContext
        ? `Prior conversation context:\n${threadContext}\n\nCurrent question:\n${pre.prompt}`
        : pre.prompt;

      const result = await claudeStream(fullPrompt, {
        cwd: MOBE_DIR,
        systemPrompt: SYSTEM_PROMPT,
        timeoutMs,
      });

      return {
        output: {
          status: 'ok',
          prompt: pre.prompt,
          shortPrompt: pre.shortPrompt,
          durationMs: result.durationMs,
          markdown: result.markdown,
          workdir: MOBE_DIR,
        },
        isError: false,
      };
    } catch (err) {
      const detail = {
        status: 'error',
        error: err.message,
        signal: err.signal || null,
        code: err.code || null,
      };
      return { output: detail, isError: true };
    } finally {
      running--;
    }
  },
};
