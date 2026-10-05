'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { Paragraph, TextRun, Document, HeadingLevel, Packer } = require('docx');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const pptxgen = require('pptxgenjs');
const { safeWriteTarget } = require('./files');

function cleanText(value, max = 100_000) {
  return String(value || '').slice(0, max);
}

function paragraphsFromText(text) {
  return cleanText(text, 100_000).split(/\r?\n/).slice(0, 4000).map((line) => {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length === 1 ? HeadingLevel.HEADING_1 : heading[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return new Paragraph({ heading: level, children: [new TextRun(heading[2])] });
    }
    return new Paragraph({ children: [new TextRun(line || ' ')] });
  });
}

async function createDocx({ title, content }) {
  const children = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(cleanText(title, 300))] }));
  children.push(...paragraphsFromText(content));
  const document = new Document({
    creator: 'Localis',
    title: cleanText(title, 300),
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(document);
}

function findUnicodeFont() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'), path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'calibri.ttf')]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
  return candidates.find((font) => {
    try { return require('node:fs').existsSync(font); } catch { return false; }
  });
}

async function createPdf({ title, content }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: cleanText(title, 300), Creator: 'Localis' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const font = findUnicodeFont();
    if (font) doc.font(font);
    if (title) doc.fontSize(22).font(font || 'Helvetica-Bold').text(cleanText(title, 300), { continued: false });
    if (title) doc.moveDown(0.8);
    doc.font(font || 'Helvetica').fontSize(11).text(cleanText(content, 100_000), { lineGap: 4, paragraphGap: 5, align: 'left' });
    doc.end();
  });
}

async function createXlsx({ title, content, sheets }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Localis';
  workbook.subject = cleanText(title, 300);
  const sourceSheets = Array.isArray(sheets) && sheets.length ? sheets.slice(0, 30) : [{ name: 'Данные', rows: [] }];
  for (const [index, source] of sourceSheets.entries()) {
    const name = cleanText(source?.name || (index === 0 ? 'Данные' : `Лист ${index + 1}`), 31).replace(/[\\/*?:\[\]]/g, ' ') || `Sheet ${index + 1}`;
    const sheet = workbook.addWorksheet(name);
    const rows = Array.isArray(source?.rows) ? source.rows.slice(0, 5000) : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      sheet.addRow(row.slice(0, 100).map((cell) => typeof cell === 'string' ? cell.slice(0, 32_000) : cell));
    }
    if (!rows.length && index === 0 && content) {
      for (const line of cleanText(content, 50_000).split(/\r?\n/)) sheet.addRow([line]);
    }
    if (sheet.rowCount > 0) {
      sheet.getRow(1).font = { bold: true, color: { argb: 'FF17243A' } };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.columns = (sheet.getRow(1).values || []).slice(1).map(() => ({ width: 22 }));
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function textToSlides({ title, content, slides }) {
  if (Array.isArray(slides) && slides.length) return slides.slice(0, 60);
  const chunks = cleanText(content, 50_000).split(/\n\s*---\s*\n/).filter(Boolean);
  if (!chunks.length) return [{ title: title || 'Презентация', body: content || '' }];
  return chunks.map((chunk, index) => {
    const lines = chunk.split(/\r?\n/);
    const first = lines[0].match(/^#{1,3}\s+(.*)$/);
    return { title: first?.[1] || `Слайд ${index + 1}`, body: lines.slice(first ? 1 : 0).join('\n') };
  });
}

async function createPptx({ title, content, slides }) {
  const presentation = new pptxgen();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'Localis';
  presentation.subject = cleanText(title, 300);
  presentation.title = cleanText(title, 300);
  presentation.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'ru-RU',
  };
  for (const [index, input] of textToSlides({ title, content, slides }).entries()) {
    const slide = presentation.addSlide();
    slide.background = { color: 'F5F7FB' };
    const slideTitle = cleanText(input?.title || (index === 0 ? title : `Слайд ${index + 1}`) || 'Без названия', 200);
    slide.addText(slideTitle, {
      x: 0.75, y: 0.45, w: 11.8, h: 0.8,
      fontFace: 'Aptos Display', fontSize: 26, bold: true,
      color: '13233A', margin: 0,
    });
    const body = Array.isArray(input?.bullets)
      ? input.bullets.map((bullet) => `•  ${cleanText(bullet, 1000)}`).join('\n')
      : cleanText(input?.body || input?.content || '', 8000);
    slide.addText(body, {
      x: 0.85, y: 1.55, w: 11.3, h: 5.15,
      fontFace: 'Aptos', fontSize: 18, color: '34445A',
      breakLine: false, valign: 'top', margin: 0.08,
      paraSpaceAfterPt: 12,
    });
    slide.addText(`${index + 1}`, {
      x: 12.3, y: 7.05, w: 0.3, h: 0.2,
      fontFace: 'Aptos', fontSize: 9, color: '8391A3', align: 'right', margin: 0,
    });
  }
  return Buffer.from(await presentation.write({ outputType: 'nodebuffer' }));
}

async function createDocument(workspaceRoot, args) {
  const format = String(args?.format || '').toLowerCase();
  if (!['docx', 'pdf', 'xlsx', 'pptx'].includes(format)) throw new Error('Поддерживаются форматы DOCX, PDF, XLSX и PPTX.');
  let relativePath = cleanText(args.path || '', 500).trim();
  if (!relativePath) throw new Error('Укажите путь выходного файла.');
  if (path.extname(relativePath).toLowerCase() !== `.${format}`) relativePath = `${relativePath}.${format}`;

  const input = {
    title: cleanText(args.title || 'Документ', 300),
    content: cleanText(args.content || '', format === 'xlsx' ? 50_000 : 100_000),
    sheets: Array.isArray(args.sheets) ? args.sheets : undefined,
    slides: Array.isArray(args.slides) ? args.slides : undefined,
  };
  let buffer;
  if (format === 'docx') buffer = await createDocx(input);
  else if (format === 'pdf') buffer = await createPdf(input);
  else if (format === 'xlsx') buffer = await createXlsx(input);
  else buffer = await createPptx(input);

  const target = await safeWriteTarget(workspaceRoot, relativePath);
  await fs.writeFile(target, buffer, { flag: 'w' });
  return { path: path.relative(workspaceRoot, target).split(path.sep).join('/'), size: buffer.byteLength, format };
}

module.exports = { createDocument };
