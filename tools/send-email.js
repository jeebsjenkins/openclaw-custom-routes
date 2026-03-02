/**
 * send-email — Send email via src/emailHelper.js with optional attachments.
 */

const fs = require('fs');
const path = require('path');
const { sendEmail } = require('../src/emailHelper');

function resolvePath(p, projectRoot) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(projectRoot || process.cwd(), p);
}

module.exports = {
  name: 'send-email',
  description: 'Send an email using configured SMTP credentials. Supports text/html body and file attachments by path.',
  timeoutMs: 60 * 1000,
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address(es), comma-separated for multiple recipients.',
      },
      subject: {
        type: 'string',
        description: 'Email subject line.',
      },
      text: {
        type: 'string',
        description: 'Plain text email body.',
      },
      html: {
        type: 'string',
        description: 'HTML email body.',
      },
      from: {
        type: 'string',
        description: 'Optional sender override.',
      },
      cc: {
        type: 'string',
        description: 'Optional CC recipients.',
      },
      bcc: {
        type: 'string',
        description: 'Optional BCC recipients.',
      },
      replyTo: {
        type: 'string',
        description: 'Optional reply-to address.',
      },
      attachments: {
        type: 'array',
        description: 'Optional attachment list. Each item supports filePath, filename, and contentType.',
        items: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            filename: { type: 'string' },
            contentType: { type: 'string' },
          },
          required: ['filePath'],
        },
      },
    },
    required: ['to', 'subject'],
  },

  async execute(input, context) {
    const {
      to,
      subject,
      text,
      html,
      from,
      cc,
      bcc,
      replyTo,
      attachments = [],
    } = input || {};

    if (!text && !html) {
      return { output: 'Either text or html body is required.', isError: true };
    }

    const resolvedAttachments = [];
    for (const item of attachments) {
      const filePath = resolvePath(item.filePath, context.projectRoot);
      if (!filePath || !fs.existsSync(filePath)) {
        return { output: `Attachment file not found: ${item.filePath}`, isError: true };
      }

      resolvedAttachments.push({
        filename: item.filename || path.basename(filePath),
        path: filePath,
        contentType: item.contentType || undefined,
      });
    }

    try {
      const result = await sendEmail({
        to,
        subject,
        text,
        html,
        from,
        cc,
        bcc,
        replyTo,
        attachments: resolvedAttachments.length ? resolvedAttachments : undefined,
      });

      return {
        output: JSON.stringify({
          success: true,
          messageId: result?.messageId || null,
          accepted: result?.accepted || [],
          rejected: result?.rejected || [],
          attachmentCount: resolvedAttachments.length,
        }, null, 2),
        isError: false,
      };
    } catch (err) {
      return {
        output: `Failed to send email: ${err.message}`,
        isError: true,
      };
    }
  },
};

