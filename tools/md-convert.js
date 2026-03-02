/**
 * md-convert — Convert Markdown to docx/pdf/html/txt via src/mdConverter.js.
 */

const fs = require('fs');
const path = require('path');
const { mdToDocx, mdToHtml, mdToPdf, mdToTxt } = require('../src/mdConverter');

const FORMAT_TO_EXT = {
  docx: '.docx',
  pdf: '.pdf',
  html: '.html',
  txt: '.txt',
};

function resolvePath(p, projectRoot) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(projectRoot || process.cwd(), p);
}

function defaultOutputPath(format, projectRoot) {
  const outDir = path.join(projectRoot || process.cwd(), 'tmp');
  const ext = FORMAT_TO_EXT[format] || '.out';
  return path.join(outDir, `md-convert-${Date.now()}${ext}`);
}

async function convert(markdown, format) {
  switch (format) {
    case 'docx':
      return mdToDocx(markdown);
    case 'pdf':
      return mdToPdf(markdown);
    case 'html':
      return mdToHtml(markdown);
    case 'txt':
      return mdToTxt(markdown);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

module.exports = {
  name: 'md-convert',
  description: 'Convert markdown content to docx, pdf, html, or txt and write output to a file path.',
  timeoutMs: 2 * 60 * 1000,
  schema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: 'Markdown content to convert. Provide this or inputPath.',
      },
      inputPath: {
        type: 'string',
        description: 'Path to a markdown file to convert. Provide this or markdown.',
      },
      format: {
        type: 'string',
        enum: ['docx', 'pdf', 'html', 'txt'],
        description: 'Target output format.',
      },
      outputPath: {
        type: 'string',
        description: 'Output file path. If omitted, file is written under ./tmp with a generated name.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Allow overwriting an existing output file path.',
        default: false,
      },
    },
    required: ['format'],
  },

  async execute(input, context) {
    const {
      markdown,
      inputPath,
      format,
      outputPath,
      overwrite = false,
    } = input || {};

    if (!markdown && !inputPath) {
      return { output: 'Provide either markdown or inputPath.', isError: true };
    }
    if (markdown && inputPath) {
      return { output: 'Provide only one of markdown or inputPath, not both.', isError: true };
    }

    let mdContent = markdown;
    if (inputPath) {
      const resolvedInput = resolvePath(inputPath, context.projectRoot);
      if (!resolvedInput || !fs.existsSync(resolvedInput)) {
        return { output: `Input file not found: ${inputPath}`, isError: true };
      }
      mdContent = fs.readFileSync(resolvedInput, 'utf8');
    }

    const resolvedOut = resolvePath(outputPath, context.projectRoot)
      || defaultOutputPath(format, context.projectRoot);
    const requiredExt = FORMAT_TO_EXT[format];
    const finalOut = path.extname(resolvedOut) ? resolvedOut : `${resolvedOut}${requiredExt}`;

    if (fs.existsSync(finalOut) && !overwrite) {
      return {
        output: `Output file already exists: ${finalOut}. Set overwrite=true or choose a new outputPath.`,
        isError: true,
      };
    }

    try {
      fs.mkdirSync(path.dirname(finalOut), { recursive: true });
      const buf = await convert(mdContent, format);
      fs.writeFileSync(finalOut, buf);

      const stats = fs.statSync(finalOut);
      return {
        output: JSON.stringify({
          success: true,
          format,
          outputPath: finalOut,
          bytes: stats.size,
        }, null, 2),
        isError: false,
      };
    } catch (err) {
      return {
        output: `Failed to convert markdown: ${err.message}`,
        isError: true,
      };
    }
  },
};

