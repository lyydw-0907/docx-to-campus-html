import JSZip from 'jszip';
import { deflateSync } from 'node:zlib';

const xml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const paragraph = (content, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
const mathRun = (text) => `<m:r><m:t>${xml(text)}</m:t></m:r>`;

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, check]);
}

function demoPng() {
  const width = 160;
  const height = 60;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      const bar = x >= 20 && x < 45 && y >= 30 || x >= 65 && x < 90 && y >= 20 || x >= 110 && x < 135 && y >= 10;
      const color = bar ? [53, 96, 130] : [242, 246, 248];
      pixels.set(color, offset);
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A synthetic OOXML fixture. It contains no application material or credentials. */
export async function makeDemoDocx() {
  const zip = new JSZip();
  const fraction = `<m:oMath><m:sSub><m:e>${mathRun('x')}</m:e><m:sub>${mathRun('1')}</m:sub></m:sSub>${mathRun('=')}<m:f><m:num>${mathRun('a+b')}</m:num><m:den>${mathRun('c')}</m:den></m:f></m:oMath>`;
  const display = `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath>${mathRun('S=')}<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>${mathRun('i=1')}</m:sub><m:sup>${mathRun('n')}</m:sup><m:e><m:sSub><m:e>${mathRun('x')}</m:e><m:sub>${mathRun('i')}</m:sub></m:sSub></m:e></m:nary></m:oMath></m:oMathPara>`;
  const image = '<w:r><w:drawing><wp:inline><wp:extent cx="1524000" cy="571500"/><wp:docPr id="1" name="示意图" descr="合成示意图"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="demo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1524000" cy="571500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  const cell = (text, bold = false) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraph(run(text, bold ? '<w:b/>' : ''))}</w:tc>`;
  const table = '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>' + cell('项目', true) + cell('内容', true) + cell('说明', true) + '</w:tr><w:tr>' + cell('正文') + cell('中文与加粗') + cell('字号统一') + '</w:tr><w:tr>' + cell('公式') + cell('行内、独立公式') + cell('保留原编号') + '</w:tr></w:tbl>';
  const body = [
    paragraph(run('大创申报转换示例'), '<w:pStyle w:val="Heading1"/>'),
    paragraph(run('这是一份合成测试文档，用于检查正文、') + run('加粗文本', '<w:b/>') + run('与段落转换。')),
    paragraph(run('上下标：H') + run('2', '<w:vertAlign w:val="subscript"/>') + run('O，面积单位 m') + run('2', '<w:vertAlign w:val="superscript"/>') + run('。')),
    paragraph(run('行内原生公式：') + fraction + run('。公式由 Word 的 OMML 节点保存。')),
    paragraph(display + '<w:r><w:tab/></w:r>' + run('(1)'), '<w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs>'),
    table,
    paragraph(image),
    paragraph(run('图 1  合成示意图（用于图片尺寸测试）。')),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  ].join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/demo.png"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`);
  zip.file('word/media/demo.png', demoPng());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** A synthetic progress report with two school fields; no user material is read. */
export async function makeProgressDemoDocx() {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const source = await zip.file('word/document.xml').async('string');
  const nextFormula = `<m:oMath>${mathRun('y=')}<m:sSup><m:e>${mathRun('x')}</m:e><m:sup>${mathRun('2')}</m:sup></m:sSup></m:oMath>`;
  const nextPlan = [
    paragraph(run('项目后期具体工作计划'), '<w:pStyle w:val="Heading1"/>'),
    paragraph(run('下一阶段先核对模型结果，再开展数值模拟与敏感性分析。', '<w:b/>') + run('本示例仅用于测试栏目复制。'), '<w:ind w:firstLineChars="200"/>'),
    paragraph(run('合成公式：') + nextFormula + run('。这一栏没有普通图片，可直接复制。'))
  ].join('');
  const report = source.replace('大创申报转换示例', '项目进展检查')
    .replace('<w:p><w:r><w:t xml:space="preserve">这是一份合成测试文档', '<w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:r><w:t xml:space="preserve">这是一份合成测试文档')
    .replace('<w:p><w:r><w:drawing>', '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>')
    .replace('<w:p><w:r><w:t xml:space="preserve">图 1', '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">图 1')
    .replace('<w:sectPr>', `${nextPlan}<w:sectPr>`);
  zip.file('word/document.xml', report);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
