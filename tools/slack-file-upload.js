/**
 * slack-file-upload — Upload files to Slack channels/threads.
 *
 * Uses Slack's files.uploadV2 API to share generated documents,
 * reports, or other files directly in Slack conversations.
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'slack-file-upload',
  description: 'Upload a file to a Slack channel or thread. Use for sharing generated documents, reports, or code files.',
  schema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the file to upload',
      },
      channel: {
        type: 'string',
        description: 'Slack channel ID to upload to (e.g. C0123ABC456)',
      },
      threadTs: {
        type: 'string',
        description: 'Optional thread timestamp to upload as a reply',
      },
      title: {
        type: 'string',
        description: 'Title for the uploaded file',
      },
      initialComment: {
        type: 'string',
        description: 'Optional comment to accompany the file upload',
      },
      filename: {
        type: 'string',
        description: 'Override filename (defaults to the basename of filePath)',
      },
    },
    required: ['filePath', 'channel'],
  },

  async execute(input, context) {
    const { filePath, channel, threadTs, title, initialComment, filename } = input;
    const { log } = context;

    // Validate file exists
    if (!fs.existsSync(filePath)) {
      return { output: `File not found: ${filePath}`, isError: true };
    }

    let slackWeb;
    try {
      const { WebClient } = require('@slack/web-api');
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (!botToken) {
        return { output: 'SLACK_BOT_TOKEN not configured in environment', isError: true };
      }
      slackWeb = new WebClient(botToken);
    } catch (err) {
      return { output: `Failed to initialize Slack client: ${err.message}`, isError: true };
    }

    try {
      const fileContent = fs.readFileSync(filePath);
      const resolvedFilename = filename || path.basename(filePath);

      const uploadParams = {
        channel_id: channel,
        file: fileContent,
        filename: resolvedFilename,
      };

      if (title) uploadParams.title = title;
      if (initialComment) uploadParams.initial_comment = initialComment;
      if (threadTs) uploadParams.thread_ts = threadTs;

      const result = await slackWeb.files.uploadV2(uploadParams);

      if (!result.ok) {
        return { output: `Slack upload error: ${result.error}`, isError: true };
      }

      const fileInfo = result.file || {};
      return {
        output: JSON.stringify({
          success: true,
          fileId: fileInfo.id,
          filename: resolvedFilename,
          channel,
          permalink: fileInfo.permalink || null,
        }, null, 2),
      };
    } catch (err) {
      if (log) log.error(`[slack-file-upload] Error: ${err.message}`);
      return { output: `Failed to upload file: ${err.message}`, isError: true };
    }
  },
};
