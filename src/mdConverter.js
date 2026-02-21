const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Convert a markdown string to a .docx Buffer using pandoc.
 * @param {string} markdown - The markdown source text
 * @returns {Promise<Buffer>} The .docx file contents
 */
function mdToDocx(markdown) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `md-${Date.now()}.md`);
    const tmpOut = path.join(os.tmpdir(), `md-${Date.now()}.docx`);

    fs.writeFileSync(tmpIn, markdown);

    execFile('pandoc', [tmpIn, '-f', 'markdown', '-t', 'docx', '-o', tmpOut], (err) => {
      // clean up input file
      fs.unlink(tmpIn, () => {});

      if (err) {
        fs.unlink(tmpOut, () => {});
        return reject(err);
      }

      fs.readFile(tmpOut, (readErr, buf) => {
        fs.unlink(tmpOut, () => {});
        if (readErr) return reject(readErr);
        resolve(buf);
      });
    });
  });
}

function mdToHtml(markdown) {
  return pandoc(markdown, 'html', '.html');
}

function mdToPdf(markdown) {
  return pandoc(markdown, 'pdf', '.pdf');
}

function mdToTxt(markdown) {
  return pandoc(markdown, 'plain', '.txt');
}

function pandoc(markdown, toFormat, ext) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `md-${Date.now()}.md`);
    const tmpOut = path.join(os.tmpdir(), `md-${Date.now()}${ext}`);

    fs.writeFileSync(tmpIn, markdown);

    const env = { ...process.env, PATH: `${process.env.PATH}:/Library/TeX/texbin` };
    execFile('pandoc', [tmpIn, '-f', 'markdown', '-t', toFormat, '-o', tmpOut], { env }, (err) => {
      fs.unlink(tmpIn, () => {});

      if (err) {
        fs.unlink(tmpOut, () => {});
        return reject(err);
      }

      fs.readFile(tmpOut, (readErr, buf) => {
        fs.unlink(tmpOut, () => {});
        if (readErr) return reject(readErr);
        resolve(buf);
      });
    });
  });
}

module.exports = { mdToDocx, mdToHtml, mdToPdf, mdToTxt };
