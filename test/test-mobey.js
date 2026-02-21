const http = require('http');

const data = JSON.stringify({ prompt: 'what is the name of the first UI you find?' });

const req = http.request('http://localhost:3100/mobey', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => console.log(body));
});

req.write(data);
req.end();
