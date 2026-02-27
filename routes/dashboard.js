const path = require('path');

module.exports = {
  path: '/dashboard',
  method: 'GET',
  description: 'Agent test console / dashboard UI',
  handler(_req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  },
};
