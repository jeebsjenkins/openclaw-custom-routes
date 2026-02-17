const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const config = require('../config');

module.exports = {
  path: '/api/tasks/:agentId/:taskId',
  method: 'PATCH',
  description: 'Update task frontmatter (status, priority, tags, status_update, todo)',

  handler: function(req, res) {
    const { agentId, taskId } = req.params;
    const tasksDir = path.join(config.workspacePath, 'tasks', agentId);
    const filePath = path.join(tasksDir, taskId + '.md');

    if (!fs.existsSync(tasksDir)) {
      return res.status(404).json({ error: 'Agent tasks directory not found', agentId });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Task file not found', file: taskId + '.md' });
    }

    if (!req.body.status) {
      return res.status(400).json({ error: 'status required in body' });
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = matter(raw);
      const frontmatter = parsed.data;

      frontmatter.status = req.body.status;
      if (req.body.priority !== undefined) frontmatter.priority = req.body.priority;
      if (req.body.tags !== undefined) frontmatter.tags = req.body.tags;
      if (req.body.updated) frontmatter.updated = req.body.updated;
      if (req.body.assignee !== undefined) frontmatter.assignee = req.body.assignee;
      if (req.body.status_update !== undefined) frontmatter.status_update = req.body.status_update;
      if (req.body.todo !== undefined) frontmatter.todo = req.body.todo;

      const updated = matter.stringify(parsed.content, frontmatter);
      fs.writeFileSync(filePath, updated, 'utf8');

      res.json({
        success: true,
        agentId,
        taskId,
        updated: frontmatter
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update task', details: err.message });
    }
  }
};
