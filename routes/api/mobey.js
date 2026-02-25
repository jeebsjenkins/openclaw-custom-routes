const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { sendSlackMessage, updateSlackMessage, uploadSlackFile, fetchThreadHistory, findRecentUserMessage, getUserInfo, mdToSlack } = require('../../src/slackHelper');
const { mdToDocx, mdToHtml, mdToPdf, mdToTxt } = require('../../src/mdConverter');
const { sendEmail } = require('../../src/emailHelper');
const { claudeStream, cleanEnv } = require('../../src/claudeHelper');

const MOBE_DIR = path.join(os.homedir(), 'Projects', 'mobe3Full');
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 3;
const STREAM_UPDATES = false; // flip to true to re-enable SSE streaming

// - `format`: Output format (default: `"md"`)
//   - `"md"` (default) - Markdown
//   - `"txt"` - Plain text
//   - `"docx"` - Word document
//   - `"html"` - HTML document
//   - `"pdf"` - PDF document

let running = 0;

const PREPROCESSING_INSTRUCTIONS = [
  'You are a preprocessing parser. Your ONLY job is to extract structured parameters from a raw user prompt.',
  'Do NOT attempt to fulfill, answer, or act on the user\'s request. Do NOT use any tools. Do NOT explain anything.',
  'Return ONLY a single valid JSON object — no markdown fences, no commentary, no extra text whatsoever.',
  '',
  'Return this exact JSON shape:',
  '{',
  '  "prompt": "the cleaned/conditioned prompt for the code analyst (keep the user\'s intent, but remove any delivery instructions like email/format requests)",',
  '  "format": "md" | "txt" | "docx" | "html" | "pdf" (default "md" — but if the user asks for email without specifying a format, use "html")',
  '  "respond_email": "email@example.com" | true | null (set to the email if they provide one; set to true if they say "email me" or "send to my email" without a specific address; null otherwise)',
  '  "reply_inline": true | false | null (true if user wants a short/inline reply, false if they explicitly want a file/attachment, null to let the system decide)',
  '  "short_prompt": "a very brief (3-6 word) label summarizing the topic, used in status updates (e.g. \"auth module\", \"database schema\", \"route overview\")"',
  '}',
  '',
  'Examples:',
  '- "explain the auth module and email it to me as a PDF" → { "prompt": "explain the auth module", "format": "pdf", "respond_email": true, "reply_inline": null, "short_prompt": "auth module" }',
  '- "explain the auth module and email it to me" → { "prompt": "explain the auth module", "format": "html", "respond_email": true, "reply_inline": null, "short_prompt": "auth module" }',
  '- "what does server.js do? send to bob@acme.com" → { "prompt": "what does server.js do?", "format": "html", "respond_email": "bob@acme.com", "reply_inline": null, "short_prompt": "server.js overview" }',
  '- "give me a quick summary of the routes" → { "prompt": "give me a quick summary of the routes", "format": "md", "respond_email": null, "reply_inline": true, "short_prompt": "route summary" }',
  '- "generate a word doc explaining the database schema" → { "prompt": "explain the database schema", "format": "docx", "respond_email": null, "reply_inline": false, "short_prompt": "database schema" }',
].join('\n');

function parsePrompt(rawPrompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', '--max-turns', '1', '--output-format', 'json',
      '--system-prompt', PREPROCESSING_INSTRUCTIONS,
      rawPrompt,
    ], {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv(),
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); }, 30_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Preprocessing failed: ${stderr || `exit ${code}`}`));
      }
      try {
        // claude --output-format json wraps result in { "result": "..." }
        const wrapper = JSON.parse(stdout);
        const text = wrapper.result || wrapper.text || stdout;
        // The inner text is our JSON — strip any markdown fences just in case
        const clean = (typeof text === 'string' ? text : JSON.stringify(text)).replace(/```json\n?|```\n?/g, '').trim();
        const parsed = JSON.parse(clean);
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Failed to parse preprocessing result: ${e.message}\nRaw: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

const SYSTEM_PROMPT = [
  'You are a code analyst for the mobe3 codebase.',
  'Your job is to examine, explain, and answer questions about the code — NOT to write or modify it.',
  'Do NOT generate new code, write programs, create files, or suggest code changes.',
  'You MAY use your tools (grep, glob, bash, read, web search) to explore the codebase and gather information.',
  'Answer with clear, concise explanations in markdown.',
].join(' ');

const SLACK_INLINE_LIMIT = 1000; // Slack message character limit for a single message (without attachments)

const FORMAT_CONFIG = {
  docx: { convert: mdToDocx, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  html: { convert: mdToHtml, contentType: 'text/html',  ext: 'html' },
  pdf:  { convert: mdToPdf,  contentType: 'application/pdf', ext: 'pdf' },
  txt:  { convert: mdToTxt,  contentType: 'text/plain', ext: 'txt' },
  md:   { convert: null,     contentType: 'text/markdown', ext: 'md' },
};

function createStatusUpdater({ statusMsg, header, res }) {
  function updateSlackStatus(event, data) {
    if (statusMsg) {
      const text = data?.text || data?.error || data?.markdown || '';
      if (text) {
        const fullMessage = header ? `${header}\n${text}` : text;
        updateSlackMessage({ channel: statusMsg.channel, ts: statusMsg.ts, message: fullMessage });
      }
      return;
    }
    if (!STREAM_UPDATES) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  return updateSlackStatus;
}

async function sendAnswer({ res, statusMsg, updateSlackStatus, answer, respond_email, format, prompt, slackUser, shortPrompt }) {
  const fmt = FORMAT_CONFIG[format] ? format : 'md';
  const cfg = FORMAT_CONFIG[fmt];
  const explicitFormat = format && format !== 'md' && FORMAT_CONFIG[format];
  const slug = shortPrompt ? shortPrompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null;
  const fileLabel = slug || 'response';
  const titleLabel = shortPrompt ? `Mobey: ${shortPrompt}` : 'Mobey Response';

  // Send email if requested
  if (respond_email && answer.ok) {
    try {
      const subject = `Mobey: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`;
      const emailOpts = { to: respond_email, subject };

      if (fmt === 'html') {
        // Send HTML as the email body
        emailOpts.html = await mdToHtml(answer.markdown);
        emailOpts.text = answer.markdown; // plain-text fallback
      } else if (explicitFormat && cfg.convert) {
        const buf = await cfg.convert(answer.markdown);
        emailOpts.text = 'See attached file.';
        emailOpts.attachments = [{ filename: `${fileLabel}.${cfg.ext}`, content: buf, contentType: cfg.contentType }];
      } else {
        emailOpts.text = answer.markdown;
      }

      await sendEmail(emailOpts);

      if (statusMsg) {
        updateSlackStatus('status', { text: `Sent results to ${respond_email}` });
        // Skip normal Slack reply — email was the primary delivery
        return sendHttpReply();
      }
    } catch (emailErr) {
      console.error('Email send failed, falling back to md:', emailErr.message);
      // Fall through to normal Slack / HTTP reply
    }
  }

  // Update Slack if we have a status message
  if (statusMsg) {
    if (!answer.ok) {
      updateSlackStatus('error', { error: answer.error });
    } else if (explicitFormat) {
      // Explicit non-md format — always upload a file
      const content = cfg.convert ? await cfg.convert(answer.markdown) : answer.markdown;
      updateSlackStatus('status', { text: `Here you go — .${cfg.ext} attached.` });
      await uploadSlackFile({
        channel: statusMsg.channel,
        content,
        filename: `${fileLabel}.${cfg.ext}`,
        title: titleLabel,
        threadTs: statusMsg.threadTs,
      });
    } else if (answer.markdown.length < SLACK_INLINE_LIMIT) {
      updateSlackStatus('text', { text: mdToSlack(answer.markdown) });
    } else {
      updateSlackStatus('status', { text: 'Here you go — full response attached.' });
      await uploadSlackFile({
        channel: statusMsg.channel,
        content: answer.markdown,
        filename: `${fileLabel}.md`,
        title: titleLabel,
        threadTs: statusMsg.threadTs,
      });
    }
  }

  // Always reply to the HTTP caller
  return sendHttpReply();

  async function sendHttpReply() {
    if (!answer.ok) {
      const { status, ...body } = answer;
      return res.status(status || 500).json(body);
    }

    if (cfg.convert) {
      const buf = await cfg.convert(answer.markdown);
      res.set('Content-Type', cfg.contentType);
      res.set('Content-Disposition', `attachment; filename="${fileLabel}.${cfg.ext}"`);
      res.send(buf);
    } else {
      res.json({ status: 'ok', markdown: answer.markdown, prompt: answer.prompt, durationMs: answer.durationMs });
    }
  }
}

module.exports = {
  path: '/mobey',
  method: 'post',
  description: 'Run a prompt through Claude CLI in mobe3Full workspace (SSE streaming)',

  async handler(req, res) {
    try {
      const ip = req.ip || req.connection.remoteAddress;
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

      if (!local) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      let { prompt: rawPrompt, timeout, slack: slackContext } = req.body || {};

      if (!rawPrompt || typeof rawPrompt !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "prompt" in request body' });
      }

      // Slack context — available throughout the handler
      let statusMsg = null;
      let slackUser = null;
      let displayName = null;      

      let slackHeader = null;

      if (slackContext) {
        let { channel, thread_ts, sender_name } = slackContext;
        slackUser = sender_name ? await getUserInfo(sender_name) : null;
        displayName = slackUser?.profile?.display_name || slackUser?.real_name || sender_name || 'friend';

        // If no thread_ts provided, find the user's most recent message to thread off
        if (!thread_ts && slackUser?.id) {
          thread_ts = await findRecentUserMessage({ channel, userId: slackUser.id });
        }

        const abbrev = rawPrompt.length > 60 ? rawPrompt.slice(0, 60) + '…' : rawPrompt;
        slackHeader = `*${displayName}*: _${abbrev}_`;
        const posted = await sendSlackMessage({ channel, message: `${slackHeader}\nOn it!`, threadTs: thread_ts });
        // Keep the original thread_ts so all replies stay in the same thread
        // (avoid threading off our own status message)
        statusMsg = { channel: posted.channel, ts: posted.ts, threadTs: thread_ts || posted.ts };
      }

      const updateSlackStatus = createStatusUpdater({ statusMsg, header: slackHeader, res });

      // Load prior thread context if we're replying in a thread
      let threadContext = '';
      if (statusMsg?.threadTs) {
        try {
          const messages = await fetchThreadHistory({
            channel: statusMsg.channel,
            threadTs: statusMsg.threadTs,
          });
          // Exclude the current message (last one) and any bot status messages
          const prior = messages.slice(0, -1).filter(m => m.text && !m.text.startsWith('On it'));
          if (prior.length) {
            threadContext = prior.map(m => `[thread] ${m.text}`).join('\n') + '\n\n';
          }
        } catch (err) {
          console.error('Failed to fetch thread history:', err.message);
        }
      }

      // Use Claude to parse the raw prompt into structured parameters
      let prompt, format, respond_email, replyInline, shortPrompt;
      try {
        updateSlackStatus('status', { text: 'Getting my stuff together...' });
        const parsed = await parsePrompt(rawPrompt);
        prompt = parsed.prompt || rawPrompt;
        format = parsed.format || 'md';
        respond_email = parsed.respond_email || null;
        replyInline = parsed.reply_inline;
        shortPrompt = parsed.short_prompt || null;
      } catch (err) {
        console.error('Preprocessing failed, using raw prompt:', err.message);
        prompt = rawPrompt;
        format = 'md';
        respond_email = null;
        replyInline = null;
        shortPrompt = null;
      }

      // Default to HTML body (no attachment) when email is requested without an explicit format
      if (respond_email && (!format || format === 'md')) {
        format = 'html';
      }

      // Resolve "email me" (true) to the Slack user's actual email
      if (respond_email === true && slackUser?.profile?.email) {
        respond_email = slackUser.profile.email;
      } else if (respond_email === true) {
        respond_email = null; // can't resolve, skip email
      }

      if (running >= MAX_CONCURRENT) {
        return res.status(429).json({ error: 'Too many concurrent requests' });
      }

      running++;
      const startedAt = Date.now();
      const timeoutMs = Math.min(timeout || TIMEOUT_MS, TIMEOUT_MS);

      if (STREAM_UPDATES && !statusMsg) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        updateSlackStatus('start', { prompt });
      }

      // Prepend thread context so Claude has prior conversation history
      const fullPrompt = threadContext ? `Prior conversation in this thread:\n${threadContext}Current question:\n${prompt}` : prompt;

      let answer;
      try {
        const result = await claudeStream(fullPrompt, {
          cwd: MOBE_DIR,
          systemPrompt: SYSTEM_PROMPT,
          timeoutMs,
        }, (type, data) => {
          updateSlackStatus(type, data);
        });
        answer = { ok: true, markdown: result.markdown, prompt, durationMs: result.durationMs };
      } catch (err) {
        const durationMs = err.durationMs || Date.now() - startedAt;
        if (err.signal) {
          answer = { ok: false, error: 'Claude CLI was killed', signal: err.signal, durationMs, status: 504 };
        } else {
          answer = { ok: false, error: err.message, code: err.code, durationMs, status: 502 };
        }
      } finally {
        running--;
      }

      await sendAnswer({ res, statusMsg, updateSlackStatus, answer, respond_email, format, prompt, slackUser, shortPrompt });
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  },
};
