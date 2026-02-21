const nodemailer = require('nodemailer');
const config = require('../config');

const transporter = nodemailer.createTransport({
  host: 'smtp.fastmail.com',
  port: 465,
  secure: true,
  auth: {
    user: config.fastmailUser,
    pass: config.fastmailAppPassword,
  },
});

/**
 * Send an email via FastMail SMTP.
 * @param {Object} options
 * @param {string} options.to - Recipient email address(es), comma-separated for multiple
 * @param {string} options.subject - Email subject line
 * @param {string} [options.text] - Plain text body
 * @param {string} [options.html] - HTML body
 * @param {string} [options.from] - Override the default sender (defaults to FASTMAIL_USER)
 * @param {string} [options.cc] - CC recipients
 * @param {string} [options.bcc] - BCC recipients
 * @param {string} [options.replyTo] - Reply-to address
 * @param {Array}  [options.attachments] - Nodemailer attachment objects
 * @returns {Promise<Object>} Nodemailer send result (includes messageId)
 */
async function sendEmail({ to, subject, text, html, from, cc, bcc, replyTo, attachments }) {
  const message = {
    from: from || `Mobey <${config.fastmailUser}>`,
    to,
    subject,
  };

  if (text) message.text = text;
  if (html) message.html = html;
  if (cc) message.cc = cc;
  if (bcc) message.bcc = bcc;
  if (replyTo) message.replyTo = replyTo;
  if (attachments) message.attachments = attachments;

  return transporter.sendMail(message);
}

module.exports = { sendEmail, transporter };
