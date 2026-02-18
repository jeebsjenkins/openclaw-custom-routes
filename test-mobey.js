const EventEmitter = require('events');
const mobey = require('./routes/mobey');

// Mock req with EventEmitter for 'close' support
const req = Object.assign(new EventEmitter(), {
  ip: '127.0.0.1',
  connection: { remoteAddress: '127.0.0.1' },
  body: {
    prompt: 'How many UIs are in mobe3? List them briefly.',
  },
});

// Mock res that parses SSE
const res = {
  writeHead(status, headers) {
    console.log(`--- SSE stream opened (${status}) ---`);
    console.log(`Headers: ${JSON.stringify(headers)}\n`);
  },
  write(chunk) {
    // Parse SSE frames: "event: <name>\ndata: <json>\n\n"
    const lines = chunk.split('\n');
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event) return;

    if (event === 'text') {
      const { text } = JSON.parse(data);
      process.stdout.write(text);
    } else if (event === 'done') {
      const parsed = JSON.parse(data);
      console.log(`\n\n--- Done (${parsed.durationMs}ms) ---`);
    } else if (event === 'error') {
      console.log(`\n--- ERROR ---`);
      console.log(JSON.stringify(JSON.parse(data), null, 2));
    } else if (event === 'start') {
      console.log(`[start] id=${JSON.parse(data).id}`);
    } else if (event === 'stderr') {
      process.stderr.write(`[stderr] ${JSON.parse(data).text}`);
    } else {
      console.log(`[${event}] ${data}`);
    }
  },
  end() {
    console.log('--- Stream closed ---');
  },
  status(code) { this._status = code; return this; },
  json(data) {
    console.log(`\n--- Response (${this._status}) ---`);
    console.log(JSON.stringify(data, null, 2));
  },
};

console.log('Spawning Claude CLI (streaming) in ~/Projects/mobe3Full ...');
console.log(`Prompt: "${req.body.prompt}"\n`);

mobey.handler(req, res);
