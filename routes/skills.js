const fs = require('fs');
const path = require('path');
const config = require('../config');

module.exports = {
  path: '/api/skills/:skillName',
  method: 'GET',
  description: 'Get skill SKILL.md content and directory listing',

  handler: function(req, res) {
    const { skillName } = req.params;
    const skillDir = path.join(config.workspacePath, 'skills', skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillDir)) {
      return res.status(404).json({ 
        error: 'Skill not found', 
        skillName 
      });
    }

    if (!fs.existsSync(skillFile)) {
      return res.status(404).json({ 
        error: 'SKILL.md not found', 
        skillName,
        directory: skillDir
      });
    }

    try {
      const content = fs.readFileSync(skillFile, 'utf8');
      const files = fs.readdirSync(skillDir);
      
      const fileDetails = files.map(file => {
        const filePath = path.join(skillDir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtime
        };
      });

      res.json({
        skillName,
        location: skillDir,
        content,
        files: fileDetails
      });
    } catch (err) {
      res.status(500).json({ 
        error: 'Failed to read skill', 
        details: err.message 
      });
    }
  }
};
