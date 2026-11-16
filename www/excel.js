/* Kế Hoạch — xuất / nhập Excel (.xlsx, .xls, .csv) không cần thư viện ngoài, chạy được offline.
 *  Xuất : .xlsx (chuẩn Office Open XML) và .xls (XML Spreadsheet 2003 — Excel/LibreOffice mở trực tiếp)
 *  Nhập : .xlsx / .xlsm, .xls (cả dạng nhị phân BIFF8 cũ lẫn XML 2003/HTML), .csv
 */
(() => {
'use strict';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');
const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const DONE_MARK = '✓', NA_MARK = '–';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const xmlEsc = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ====================================================================
 *  1. MÔ HÌNH BẢNG THÁNG (dùng chung cho .xlsx / .xls)
 * ==================================================================== */
// style: 0 mặc định, 1 tiêu đề cột, 2 tiêu đề lớn, 3 ghi chú nhỏ, 4 ô chữ, 5 ô giữa, 6 ô đã làm, 7 ô không có lịch, 8 ô xám (ID)
function byTime(a, b) { return ((a.startTime || '99:99') + a.id).localeCompare((b.startTime || '99:99') + b.id); }

function buildModel(tasks, year, month) {
  const dim = new Date(year, month + 1, 0).getDate();
  const list = tasks.filter((t) => !t.deleted).sort(byTime);          // có giờ lên đầu theo thứ tự, không giờ xuống cuối
  const dayCol0 = 4;                                                  // A..D cố định, ngày bắt đầu từ cột E
  const rows = [];
  rows.push([{ v: `KẾ HOẠCH THÁNG ${month + 1}/${year}`, s: 2 }]);
  rows.push([{ v: 'Ô ngày: ✓ = đã làm · để trống = chưa làm · – = không có lịch hôm đó. Cột Giờ nhập dạng 07:30 (việc không có giờ sẽ xếp cuối). Có thể thêm dòng mới rồi nhập lại vào app.', s: 3 }]);
  const wk = [{ v: '', s: 0 }, { v: '', s: 0 }, { v: '', s: 0 }, { v: '', s: 0 }];
  for (let d = 1; d <= dim; d++) wk.push({ v: WEEK[new Date(year, month, d).getDay()], s: 3 });
  rows.push(wk);
  const head = [{ v: 'Kế hoạch', s: 1 }, { v: 'Giờ', s: 1 }, { v: 'Thời lượng (phút)', s: 1 }, { v: 'Lặp lại', s: 1 }];
  for (let d = 1; d <= dim; d++) head.push({ v: d, s: 1, n: true });
  head.push({ v: 'Hoàn thành', s: 1 }, { v: 'Ghi chú', s: 1 }, { v: 'ID (không sửa)', s: 1 });
  rows.push(head);
  for (const t of list) {
    const dows = [...t.daysOfWeek].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const r = [{ v: t.title, s: 4 }, { v: t.startTime || '', s: 5 }, t.duration ? { v: t.duration, s: 9, n: true } : { v: '', s: 9 }, { v: dows.map((d) => WEEK[d]).join(', '), s: 4 }];
    let due = 0, done = 0;
    for (let d = 1; d <= dim; d++) {
      const dt = new Date(year, month, d), ds = `${year}-${pad(month + 1)}-${pad(d)}`;
      if (t.daysOfWeek.includes(dt.getDay())) {
        due++;
        if (t.completions[ds]) { done++; r.push({ v: DONE_MARK, s: 6 }); } else r.push({ v: '', s: 5 });
      } else r.push({ v: NA_MARK, s: 7 });
    }
    r.push({ v: `${done}/${due}`, s: 5 }, { v: t.note || '', s: 4 }, { v: t.id, s: 8 });
    rows.push(r);
  }
  const widths = [30, 8, 13, 17];
  for (let d = 1; d <= dim; d++) widths.push(4.3);
  widths.push(11, 32, 15);
  return { name: `Tháng ${month + 1}-${year}`, rows, widths, freezeCols: 1, freezeRows: 4, dayCol0, dim };
}

/* ====================================================================
 *  2. GHI .xlsx
 * ==================================================================== */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function zipStore(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="15"/><color rgb="FF1E3A8A"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FF047857"/><name val="Calibri"/></font>
<font><sz val="9"/><color rgb="FF94A3B8"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="49" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function buildXlsx(model) {
  const sheetRows = model.rows.map((row, ri) => {
    const cells = row.map((c, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (c.n && typeof c.v === 'number') return `<c r="${ref}" s="${c.s || 0}"><v>${c.v}</v></c>`;
      if (c.v === '' || c.v == null) return `<c r="${ref}" s="${c.s || 0}"/>`;
      return `<c r="${ref}" s="${c.s || 0}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
    }).join('');
    const ht = ri === 3 ? ' ht="32" customHeight="1"' : '';
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join('');
  const cols = model.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const tl = colName(model.freezeCols) + (model.freezeRows + 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane xSplit="${model.freezeCols}" ySplit="${model.freezeRows}" topLeftCell="${tl}" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="${tl}" sqref="${tl}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${sheetRows}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/></worksheet>`;
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${xmlEsc(model.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', XLSX_STYLES],
    ['xl/worksheets/sheet1.xml', sheet],
  ].map(([name, text]) => ({ name, data: enc.encode(text) }));
  return zipStore(files);
}

/* ====================================================================
 *  3. GHI .xls (XML Spreadsheet 2003)
 * ==================================================================== */
function buildXls(model) {
  const st = (id, extra) => `<Style ss:ID="s${id}">${extra}</Style>`;
  const border = '<Borders><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/></Borders>';
  const styles = '<Styles>'
    + '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>'
    + st(1, `<Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>${border}<Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1E3A8A" ss:Pattern="Solid"/>`)
    + st(2, '<Font ss:FontName="Calibri" ss:Size="15" ss:Bold="1" ss:Color="#1E3A8A"/>')
    + st(3, '<Alignment ss:Horizontal="Center"/><Font ss:FontName="Calibri" ss:Size="10" ss:Italic="1" ss:Color="#64748B"/>')
    + st(4, `<Alignment ss:Vertical="Center" ss:WrapText="1"/>${border}<NumberFormat ss:Format="@"/>`)
    + st(5, `<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${border}<NumberFormat ss:Format="@"/>`)
    + st(6, `<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${border}<Font ss:FontName="Calibri" ss:Size="12" ss:Bold="1" ss:Color="#047857"/><Interior ss:Color="#D1FAE5" ss:Pattern="Solid"/>`)
    + st(7, `<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${border}<Font ss:FontName="Calibri" ss:Size="10" ss:Color="#64748B"/><Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>`)
    + st(9, `<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${border}`)
    + st(8, `${border}<Font ss:FontName="Calibri" ss:Size="9" ss:Color="#94A3B8"/><NumberFormat ss:Format="@"/>`)
    + '</Styles>';
  const cols = model.widths.map((w) => `<Column ss:AutoFitWidth="0" ss:Width="${Math.round(w * 5.6)}"/>`).join('');
  const rows = model.rows.map((row, ri) => {
    const cells = row.map((c) => {
      const sid = c.s ? ` ss:StyleID="s${c.s}"` : '';
      if (c.n && typeof c.v === 'number') return `<Cell${sid}><Data ss:Type="Number">${c.v}</Data></Cell>`;
      if (c.v === '' || c.v == null) return `<Cell${sid}/>`;
      return `<Cell${sid}><Data ss:Type="String">${xmlEsc(c.v)}</Data></Cell>`;
    }).join('');
    return `<Row${ri === 3 ? ' ss:Height="32"' : ''}>${cells}</Row>`;
  }).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${styles}<Worksheet ss:Name="${xmlEsc(model.name)}"><Table>${cols}${rows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>${model.freezeRows}</SplitHorizontal><TopRowBottomPane>${model.freezeRows}</TopRowBottomPane><SplitVertical>${model.freezeCols}</SplitVertical><LeftColumnRightPane>${model.freezeCols}</LeftColumnRightPane><ActivePane>0</ActivePane></WorksheetOptions></Worksheet></Workbook>`;
  return enc.encode(xml);
}

/* ====================================================================
 *  4. ĐỌC FILE → các sheet dạng bảng 2 chiều.   Ô = {v, d} (d = là ngày/giờ Excel)
 * ==================================================================== */
async function inflateRaw(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt quá cũ, chưa đọc được .xlsx. Hãy cập nhật Chrome/Safari.');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function openZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('File không phải .xlsx hợp lệ.');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries[name] = { method, csize, lho };
    p += 46 + nlen + elen + clen;
  }
  return {
    has: (name) => name in entries,
    async text(name) {
      const e = entries[name]; if (!e) return null;
      const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
      const comp = u8.subarray(start, start + e.csize);
      return dec.decode(e.method === 0 ? comp : await inflateRaw(comp));
    },
  };
}

const xml = (text) => { const d = new DOMParser().parseFromString(text, 'application/xml'); if (d.querySelector('parsererror')) throw new Error('File XML bị lỗi.'); return d; };
const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const isDateFmt = (code) => { const c = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, ''); return /[dmyhs]/i.test(c) && !/^general$/i.test(c); };
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

async function readXlsx(u8) {
  const zip = openZip(u8);
  const wbText = await zip.text('xl/workbook.xml');
  if (!wbText) throw new Error('Không tìm thấy dữ liệu bảng tính trong file.');
  const wb = xml(wbText);
  const date1904 = [...wb.getElementsByTagName('workbookPr')].some((e) => /^(1|true)$/i.test(e.getAttribute('date1904') || ''));
  const relsText = await zip.text('xl/_rels/workbook.xml.rels');
  const rels = {};
  if (relsText) for (const r of xml(relsText).getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');

  const shared = [];
  const ssText = await zip.text('xl/sharedStrings.xml');
  if (ssText) for (const si of xml(ssText).getElementsByTagName('si')) {
    let s = '';
    const walk = (el) => { for (const c of el.children) { if (c.localName === 't') s += c.textContent; else if (c.localName === 'r') kids(c, 't').forEach((t) => { s += t.textContent; }); } };
    walk(si);
    shared.push(s);
  }

  const dateXf = [];
  const stText = await zip.text('xl/styles.xml');
  if (stText) {
    const st = xml(stText), custom = {};
    for (const nf of st.getElementsByTagName('numFmt')) custom[nf.getAttribute('numFmtId')] = nf.getAttribute('formatCode');
    const xfs = st.getElementsByTagName('cellXfs')[0];
    if (xfs) for (const xf of kids(xfs, 'xf')) {
      const id = xf.getAttribute('numFmtId');
      dateXf.push(BUILTIN_DATE.has(+id) || (custom[id] != null && isDateFmt(custom[id])));
    }
  }

  const sheets = [];
  for (const sh of wb.getElementsByTagName('sheet')) {
    const name = sh.getAttribute('name');
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = rels[rid]; if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const text = await zip.text(target); if (!text) continue;
    const doc = xml(text), rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const ri = (parseInt(row.getAttribute('r'), 10) || rows.length + 1) - 1;
      const arr = rows[ri] || (rows[ri] = []);
      let ci = 0;
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r');
        if (ref) ci = colIndex(ref);
        const t = c.getAttribute('t'), s = parseInt(c.getAttribute('s') || '0', 10);
        const vEl = kids(c, 'v')[0];
        let v = null, d = false;
        if (t === 'inlineStr') { const is = kids(c, 'is')[0]; v = is ? is.textContent : ''; }
        else if (vEl) {
          const raw = vEl.textContent;
          if (t === 's') v = shared[+raw] ?? '';
          else if (t === 'str') v = raw;
          else if (t === 'b') v = raw === '1';
          else if (t === 'e') v = null;
          else { v = Number(raw); if (Number.isNaN(v)) v = raw; else d = !!dateXf[s]; }
        }
        if (v !== null) arr[ci] = { v, d };
        ci++;
      }
    }
    sheets.push({ name, rows: Array.from(rows, (r) => r || []), date1904 });
  }
  return sheets;
}

/* ---- XML Spreadsheet 2003 / HTML / CSV ---- */
function readSpreadsheetML(text) {
  const doc = xml(text), sheets = [];
  for (const ws of doc.getElementsByTagName('Worksheet')) {
    const name = ws.getAttribute('ss:Name') || ws.getAttribute('Name') || 'Sheet';
    const rows = [];
    for (const row of ws.getElementsByTagName('Row')) {
      const arr = [];
      let ci = 0;
      for (const cell of kids(row, 'Cell')) {
        const idx = cell.getAttribute('ss:Index') || cell.getAttribute('Index');
        if (idx) ci = parseInt(idx, 10) - 1;
        const data = kids(cell, 'Data')[0];
        if (data) {
          const type = data.getAttribute('ss:Type') || data.getAttribute('Type') || 'String';
          const raw = data.textContent;
          if (type === 'Number') arr[ci] = { v: Number(raw), d: false };
          else if (type === 'Boolean') arr[ci] = { v: raw === '1' || /true/i.test(raw), d: false };
          else arr[ci] = { v: raw, d: false };
        }
        ci += 1 + parseInt(cell.getAttribute('ss:MergeAcross') || '0', 10);
      }
      rows.push(Array.from(arr, (x) => x || null));
    }
    sheets.push({ name, rows: rows.map((r) => r.map((x) => x || undefined)), date1904: false });
  }
  return sheets;
}

function readHtmlTables(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return [...doc.querySelectorAll('table')].map((tb, i) => ({
    name: 'Bảng ' + (i + 1), date1904: false,
    rows: [...tb.querySelectorAll('tr')].map((tr) => [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName)).map((c) => { const t = c.textContent.trim(); return t === '' ? undefined : { v: t, d: false }; })),
  }));
}

function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return [{ name: 'CSV', date1904: false, rows: rows.map((r) => r.map((c) => (c === '' ? undefined : { v: c, d: false }))) }];
}

/* ---- .xls nhị phân (OLE2 + BIFF8) ---- */
function readOle(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
  const secSize = 1 << dv.getUint16(30, true), miniSize = 1 << dv.getUint16(32, true), cutoff = dv.getUint32(56, true);
  const sec = (id) => u8.subarray((id + 1) * secSize, (id + 2) * secSize);
  const difat = [];
  for (let i = 0; i < 109; i++) { const v = dv.getUint32(76 + i * 4, true); if (v < 0xFFFFFFFA) difat.push(v); }
  let nd = dv.getUint32(68, true), cnt = dv.getUint32(72, true);
  while (cnt-- > 0 && nd < 0xFFFFFFFA) { const s = sec(nd), sd = new DataView(s.buffer, s.byteOffset, s.length); for (let i = 0; i < secSize / 4 - 1; i++) { const v = sd.getUint32(i * 4, true); if (v < 0xFFFFFFFA) difat.push(v); } nd = sd.getUint32(secSize - 4, true); }
  const fat = [];
  for (const id of difat) { const s = sec(id), sd = new DataView(s.buffer, s.byteOffset, s.length); for (let i = 0; i < secSize / 4; i++) fat.push(sd.getUint32(i * 4, true)); }
  const chain = (start, table, getSec) => { const out = []; let id = start, guard = 0; while (id < 0xFFFFFFFA && guard++ < 1e6) { out.push(getSec(id)); id = table[id]; } return concat(out); };
  const dir = chain(dv.getUint32(48, true), fat, sec);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.length);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = ddv.getUint16(o + 64, true); if (!nl) continue;
    let name = ''; for (let i = 0; i < nl / 2 - 1; i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
    entries.push({ name, type: dir[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
  }
  const root = entries.find((e) => e.type === 5);
  let mini = null, miniFat = null;
  const stream = (e) => {
    if (e.size >= cutoff) return chain(e.start, fat, sec).subarray(0, e.size);
    if (!mini) {
      mini = chain(root.start, fat, sec);
      const mf = chain(dv.getUint32(60, true), fat, sec), mdv = new DataView(mf.buffer, mf.byteOffset, mf.length);
      miniFat = []; for (let i = 0; i < mf.length / 4; i++) miniFat.push(mdv.getUint32(i * 4, true));
    }
    return chain(e.start, miniFat, (id) => mini.subarray(id * miniSize, (id + 1) * miniSize)).subarray(0, e.size);
  };
  const wbEntry = entries.find((e) => e.type === 2 && (e.name === 'Workbook' || e.name === 'Book'));
  if (!wbEntry) throw new Error('Không tìm thấy bảng tính trong file .xls.');
  return stream(wbEntry);
}

function readBiff(u8) {
  const wb = readOle(u8);
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.length);
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const recs = [];
  for (let p = 0; p + 4 <= wb.length;) { const t = dv.getUint16(p, true), l = dv.getUint16(p + 2, true); recs.push({ t, d: wb.subarray(p + 4, p + 4 + l), pos: p }); p += 4 + l; }
  if (!recs.length || recs[0].t !== 0x0809 || u16(recs[0].d, 0) !== 0x0600) throw new Error('File .xls này là định dạng quá cũ (Excel 5/95). Hãy mở bằng Excel rồi Lưu thành .xlsx.');

  const str = (b, o, cch, wide) => { let s = ''; if (wide) for (let i = 0; i < cch; i++) s += String.fromCharCode(u16(b, o + i * 2)); else for (let i = 0; i < cch; i++) s += String.fromCharCode(b[o + i]); return s; };
  let date1904 = false;
  const formats = {}, xfFmt = [], sst = [], sheetsInfo = [];
  let i = 0;
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (r.t === 0x0022) date1904 = u16(r.d, 0) === 1;
    else if (r.t === 0x041E) { const idx = u16(r.d, 0), cch = u16(r.d, 2), fl = r.d[4]; formats[idx] = str(r.d, 5, cch, fl & 1); }
    else if (r.t === 0x00E0) xfFmt.push(u16(r.d, 2));
    else if (r.t === 0x0085) { const cch = r.d[6], fl = r.d[7]; sheetsInfo.push({ offset: u32(r.d, 0), type: r.d[5], name: str(r.d, 8, cch, fl & 1) }); }
    else if (r.t === 0x00FC) {
      const chunks = [r.d];
      while (recs[i + 1] && recs[i + 1].t === 0x003C) chunks.push(recs[++i].d);
      let ci = 0, cur = chunks[0], p = 8; const unique = u32(cur, 4);
      const skip = (n) => { while (n > 0) { if (p >= cur.length) { ci++; if (!chunks[ci]) return; cur = chunks[ci]; p = 0; continue; } const t = Math.min(n, cur.length - p); p += t; n -= t; } };
      for (let k = 0; k < unique; k++) {
        if (p >= cur.length) { ci++; if (!chunks[ci]) break; cur = chunks[ci]; p = 0; }
        const cch = u16(cur, p); p += 2; const fl = cur[p]; p += 1;
        let rich = 0, ext = 0;
        if (fl & 8) { rich = u16(cur, p); p += 2; }
        if (fl & 4) { ext = u32(cur, p); p += 4; }
        let wide = fl & 1, s = '', remain = cch;
        while (remain > 0) {
          if (p >= cur.length) { ci++; if (!chunks[ci]) break; cur = chunks[ci]; p = 0; wide = cur[p] & 1; p += 1; }
          const take = Math.min(Math.floor((cur.length - p) / (wide ? 2 : 1)), remain);
          if (take <= 0) { p = cur.length; continue; }
          s += str(cur, p, take, wide); p += take * (wide ? 2 : 1); remain -= take;
        }
        skip(rich * 4 + ext);
        sst.push(s);
      }
    }
    else if (r.t === 0x000A) break;         // EOF của phần globals
  }
  const isDateXf = (xf) => { const f = xfFmt[xf]; return BUILTIN_DATE.has(f) || (formats[f] != null && isDateFmt(formats[f])); };
  const rkVal = (v) => {
    let n;
    if (v & 2) n = (v | 0) >> 2;
    else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, (v & 0xFFFFFFFC) >>> 0, true); n = b.getFloat64(0, true); }
    return v & 1 ? n / 100 : n;
  };

  const sheets = [];
  for (const info of sheetsInfo) {
    if (info.type !== 0) continue;                    // chỉ worksheet
    let k = recs.findIndex((r) => r.pos === info.offset);
    if (k < 0) continue;
    const rows = [];
    const put = (r, c, v, d) => { (rows[r] || (rows[r] = []))[c] = { v, d: !!d }; };
    let lastFormula = null;
    for (k++; k < recs.length; k++) {
      const { t, d } = recs[k];
      if (t === 0x000A) break;
      if (t === 0x00FD) put(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? '', false);
      else if (t === 0x0203) put(u16(d, 0), u16(d, 2), new DataView(d.buffer, d.byteOffset + 6, 8).getFloat64(0, true), isDateXf(u16(d, 4)));
      else if (t === 0x027E) put(u16(d, 0), u16(d, 2), rkVal(u32(d, 6)), isDateXf(u16(d, 4)));
      else if (t === 0x00BD) { const r = u16(d, 0), c0 = u16(d, 2), n = (d.length - 6) / 6; for (let j = 0; j < n; j++) put(r, c0 + j, rkVal(u32(d, 4 + j * 6 + 2)), isDateXf(u16(d, 4 + j * 6))); }
      else if (t === 0x0204) { const cch = u16(d, 6), fl = d[8]; put(u16(d, 0), u16(d, 2), str(d, 9, cch, fl & 1), false); }
      else if (t === 0x0205) { if (!d[7]) put(u16(d, 0), u16(d, 2), !!d[6], false); }
      else if (t === 0x0006) {
        const r = u16(d, 0), c = u16(d, 2);
        if (u16(d, 12) === 0xFFFF && d[6] === 0) lastFormula = [r, c];                  // kết quả chuỗi nằm ở record STRING kế tiếp
        else if (u16(d, 12) === 0xFFFF && d[6] === 1) put(r, c, !!d[8], false);
        else if (u16(d, 12) !== 0xFFFF) put(r, c, new DataView(d.buffer, d.byteOffset + 6, 8).getFloat64(0, true), isDateXf(u16(d, 4)));
      }
      else if (t === 0x0207 && lastFormula) { const cch = u16(d, 0), fl = d[2]; put(lastFormula[0], lastFormula[1], str(d, 3, cch, fl & 1), false); lastFormula = null; }
    }
    sheets.push({ name: info.name, rows: Array.from(rows, (r) => (r ? Array.from(r, (x) => x) : [])), date1904 });
  }
  return sheets;
}

async function parseWorkbook(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 8) throw new Error('File rỗng.');
  if (u8[0] === 0x50 && u8[1] === 0x4B) return readXlsx(u8);
  if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return readBiff(u8);
  const text = dec.decode(u8);
  if (/<Workbook[\s>]/i.test(text) && /urn:schemas-microsoft-com:office:spreadsheet/.test(text)) return readSpreadsheetML(text);
  if (/<table[\s>]/i.test(text)) return readHtmlTables(text);
  return readCsv(text);
}

/* ====================================================================
 *  5. NHẬN DIỆN BẢNG KẾ HOẠCH: cột, tháng/năm, giờ giấc, thứ lặp, ô đã làm
 * ==================================================================== */
const cellStr = (c) => (c == null || c.v == null ? '' : c.d && typeof c.v === 'number' ? '' : typeof c.v === 'number' ? String(c.v) : String(c.v)).trim();

function serialToParts(serial, date1904) {
  const ms = (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + Math.round(serial * 86400000);
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function parseTime(c) {
  if (c == null || c.v == null || c.v === '') return '';
  if (typeof c.v === 'number') {
    let f = c.v;
    if (c.d || (f > 0 && f < 1)) { f = f - Math.floor(f); const mins = Math.round(f * 1440) % 1440; return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; }
    if (Number.isInteger(f) && f >= 0 && f <= 23) return `${pad(f)}:00`;
    return '';
  }
  const s = norm(c.v).replace(/\s+/g, ' ');
  const m = /(\d{1,2})\s*(?:[:hg.]|gio)\s*(\d{1,2})?\s*(?:phut|p\b)?\s*(am|pm|sa|ch|sang|chieu|toi)?/.exec(s) || /^(\d{1,2})\s*(am|pm|sa|ch|sang|chieu|toi)?$/.exec(s);
  if (!m) return '';
  let h = +m[1], mi = m[2] && /^\d/.test(m[2]) ? +m[2] : 0;
  const suf = (m[3] || (m[2] && /^\D/.test(m[2]) ? m[2] : '') || '');
  if (/^(pm|ch|chieu|toi)/.test(suf) && h < 12) h += 12;
  if (/^(am|sa|sang)/.test(suf) && h === 12) h = 0;
  if (h > 23 || mi > 59) return '';
  return `${pad(h)}:${pad(mi)}`;
}

function parseDuration(c) {
  if (c == null || c.v == null || c.v === '') return 0;
  if (typeof c.v === 'number') return c.d ? Math.round((c.v - Math.floor(c.v)) * 1440) : Math.max(0, Math.round(c.v));
  const s = norm(c.v);
  let m = /(\d+)\s*(?:h|gio)\s*(\d+)?/.exec(s);
  if (m) return +m[1] * 60 + (+m[2] || 0);
  m = /(\d+)/.exec(s);
  return m ? +m[1] : 0;
}

function parseDays(c) {
  const s = norm(cellStr(c));
  if (!s) return null;
  if (/(hang ngay|moi ngay|daily|every ?day|tat ca|all)/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set();
  let rest = s.replace(/thu\s*/g, 't').replace(/chu\s*nhat/g, 'cn');
  rest = rest.replace(/t\s*([2-7])\s*(?:-|den|to)\s*t?\s*([2-7])/g, (_, a, b) => { for (let x = +a; x <= +b; x++) out.add(x - 1); return ' '; });
  if (/(^|[^a-z])cn([^a-z]|$)/.test(rest)) out.add(0);
  for (const m of rest.matchAll(/(?:^|[^a-z])t\s*([2-7])(?!\d)/g)) out.add(+m[1] - 1);
  if (/\bhai\b/.test(rest)) out.add(1);
  return out.size ? [...out].sort() : null;
}

function isDone(c) {
  if (c == null || c.v == null) return false;
  if (c.v === true) return true;
  if (typeof c.v === 'number') return c.v === 1;
  const s = norm(c.v);
  return ['✓', '✔', '☑', '✅', 'x', 'v', '1', 'true', 'co', 'da', 'done', 'yes', 'y', 'ok', 'xong', 'hoan thanh'].includes(s);
}
const isNA = (c) => c != null && typeof c.v === 'string' && /^[–—-]+$/.test(c.v.trim());

function dayHeader(c, date1904) {
  if (c == null || c.v == null) return null;
  if (typeof c.v === 'number') {
    if (c.d) { const p = serialToParts(c.v, date1904); return { day: p.d, month: p.m, year: p.y }; }
    return Number.isInteger(c.v) && c.v >= 1 && c.v <= 31 ? { day: c.v } : null;
  }
  const s = norm(c.v);
  let m = /^(?:ngay\s*)?(\d{1,2})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 31) return { day: +m[1] };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { day: +m[3], month: +m[2], year: +m[1] };
  m = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) return { day: +m[1], month: +m[2], year: m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : undefined };
  return null;
}

function mapHeader(row, date1904) {
  const map = { title: -1, time: -1, duration: -1, days: -1, note: -1, id: -1, dayCols: [] };
  row.forEach((c, i) => {
    if (c == null || c.v == null) return;
    const s = norm(cellStr(c));
    let hit = true;
    if (!s) hit = false;
    else if (map.title < 0 && /^(ke hoach|cong viec|ten cong viec|ten viec|viec|task|name|noi dung|ten)\b/.test(s)) map.title = i;
    else if (map.time < 0 && /^(gio|time|start)/.test(s)) map.time = i;
    else if (map.duration < 0 && /^(thoi luong|thoi gian|duration|phut)/.test(s)) map.duration = i;
    else if (map.days < 0 && /^(lap|thu|repeat|ngay lap)/.test(s)) map.days = i;
    else if (map.note < 0 && /^(ghi chu|note|mo ta)/.test(s)) map.note = i;
    else if (map.id < 0 && /^id\b/.test(s)) map.id = i;
    else hit = false;
    if (!hit) { const dh = dayHeader(c, date1904); if (dh) map.dayCols.push({ col: i, ...dh }); }
  });
  return map;
}

function detectMonth(sheet, h, map, fb) {
  const dated = map.dayCols.find((d) => d.month);
  if (dated) return { month: dated.month, year: dated.year || fb.year, from: 'header' };
  const texts = [sheet.name];
  for (let r = 0; r <= h; r++) for (const c of sheet.rows[r] || []) if (c && c.v != null && !(typeof c.v === 'number')) texts.push(String(c.v));
  for (const t of texts) {
    const s = norm(t);
    let m = /thang\s*(\d{1,2})\D{1,6}(20\d\d)/.exec(s) || /(\d{1,2})\s*[\/.\-]\s*(20\d\d)/.exec(s);
    if (m && +m[1] >= 1 && +m[1] <= 12) return { month: +m[1], year: +m[2], from: 'title' };
    m = /(20\d\d)\s*[\/.\-]\s*(\d{1,2})(?!\d)/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { month: +m[2], year: +m[1], from: 'title' };
  }
  return { month: fb.month + 1, year: fb.year, from: 'fallback' };
}

/* Trả về null nếu sheet không giống bảng kế hoạch */
function parseMonthTable(sheet, fb) {
  let h = -1, map = null;
  for (let r = 0; r < Math.min(sheet.rows.length, 30); r++) {
    const m = mapHeader(sheet.rows[r] || [], sheet.date1904);
    if (m.title >= 0 && (m.time >= 0 || m.duration >= 0 || m.days >= 0 || m.note >= 0 || m.dayCols.length)) { h = r; map = m; break; }
  }
  if (h < 0) return null;
  const mo = detectMonth(sheet, h, map, fb);
  const dim = new Date(mo.year, mo.month, 0).getDate();
  const items = [];
  for (let r = h + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const title = cellStr(row[map.title]);
    if (!title) continue;
    if (/^(tong|total|tien do|chu thich|huong dan|ghi chu:|trung binh)/.test(norm(title))) continue;
    const it = {
      title,
      id: map.id >= 0 ? cellStr(row[map.id]) : '',
      time: map.time >= 0 ? parseTime(row[map.time]) : undefined,
      duration: map.duration >= 0 ? parseDuration(row[map.duration]) : undefined,
      note: map.note >= 0 ? cellStr(row[map.note]) : undefined,
      days: map.days >= 0 ? parseDays(row[map.days]) : null,
      marks: {},
    };
    for (const dc of map.dayCols) {
      if (dc.day > dim) continue;
      const cell = row[dc.col];
      it.marks[`${mo.year}-${pad(mo.month)}-${pad(dc.day)}`] = isDone(cell) ? 'done' : isNA(cell) ? 'na' : 'todo';
    }
    items.push(it);
  }
  return { sheetName: sheet.name, month: mo.month, year: mo.year, monthFrom: mo.from, hasDays: map.dayCols.length > 0, cols: { time: map.time >= 0, duration: map.duration >= 0, note: map.note >= 0, days: map.days >= 0 }, items };
}

window.KHExcel = { buildModel, buildXlsx, buildXls, parseWorkbook, parseMonthTable, parseTime, parseDuration, parseDays, byTime };
})();
