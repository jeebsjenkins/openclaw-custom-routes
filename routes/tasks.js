const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const config = require('../config');

module.exports = {
  path: '/api/tasks/:agentId',
  method: 'GET',
  description: 'List tasks for a given agent, parsed from workspace markdown files',

  handler(req, res) {
    const { agentId } = req.params;
    const tasksDir = path.join(config.workspacePath, 'tasks', agentId);

    if (!fs.existsSync(tasksDir)) {
      return res.status(404).json({
        error: 'Agent not found',
        agentId,
      });
    }

    let files;
    try {
      files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md'));
    } catch (err) {
      return res.status(500).json({
        error: 'Failed to read tasks directory',
        details: err.message,
      });
    }

    const tasks = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
        const { data: frontmatter, content } = matter(raw);
        tasks.push({
          file,
          ...frontmatter,
          content: content.trim(),
        });
      } catch (err) {
        tasks.push({
          file,
          error: `Failed to parse: ${err.message}`,
        });
      }
    }

    res.json({ agentId, count: tasks.length, tasks });
  },
};
