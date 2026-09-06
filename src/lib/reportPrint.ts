// ============================================================================
//  COMPTES RENDUS ET RAPPORTS IMPRIMÉS
// ----------------------------------------------------------------------------
//  Même papier à en-tête que le bon de livraison de l'entreprise :
//  raison sociale soulignée, activité, lieu d'activité, siège social + tél,
//  mention « <VILLE> LE jj/mm/aaaa », titre du document souligné, bloc
//  d'identification, puis les sections en tableaux encadrés.
//
//  L'API publique (ReportDoc / PrintTableSection / PrintRow / PrintKpi) est
//  inchangée : compte rendu client, compte rendu fournisseur, rapport de caisse
//  et rapport général passent tous par `printDetailedReport()`.
// ============================================================================
import type { StoreSettings, Lang } from '@/types';
import { formatDate, formatDateTime } from './utils';

export type CellTone = 'default' | 'pos' | 'neg' | 'muted' | 'accent';
export type RowVariant = 'category' | 'subheader' | 'detail' | 'subtotal' | 'total';

export interface PrintCol {
  label: string;
  align?: 'left' | 'right' | 'center';
}

export interface PrintRow {
  cells: string[];
  variant?: RowVariant;
  /** Tone applied to the LAST cell (usually the amount). */
  tone?: CellTone;
  /** When true, the first cell spans all columns but the last one. */
  span?: boolean;
}

export interface PrintTableSection {
  title: string;
  icon?: string; // emoji
  note?: string;
  headerTotal?: string;
  cols: PrintCol[];
  rows: PrintRow[];
  emptyLabel?: string;
}

export interface PrintKpi {
  label: string;
  value: string;
  tone?: CellTone;
}

export interface PrintMeta {
  label: string;
  value: string;
}

export interface ReportDoc {
  docTitle: string;   // browser tab title
  headTitle: string;  // big printed title, e.g. "COMPTE RENDU CLIENT"
  subtitle: string;   // period / date label
  meta?: PrintMeta[];
  kpis?: PrintKpi[];
  sections: PrintTableSection[];
}

// ------------------------------------------------------------ small helpers
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const toneClass: Record<CellTone, string> = {
  default: '', pos: 'pos', neg: 'neg', muted: 'muted', accent: 'accent',
};

/** Ville de l'en-tête — réglage du magasin, sinon dernier segment de l'adresse. */
function headerCity(store: StoreSettings): string {
  if (store.city && store.city.trim()) return store.city.trim().toUpperCase();
  const parts = (store.address || '').split(/[,\-–]/).map((p) => p.trim()).filter(Boolean);
  return (parts[parts.length - 1] || '').toUpperCase();
}

// ------------------------------------------------------------------- styles
const css = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Times New Roman', Times, Georgia, serif;
    color: #000; background: #E9EDF0; padding: 16px;
    font-size: 12.5px; line-height: 1.35;
  }

  .toolbar { max-width: 900px; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 9px; }
  .toolbar button { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; border: 2px solid #000; border-radius: 4px; padding: 8px 20px; background: #000; color: #fff; }
  .toolbar button.ghost { background: #fff; color: #000; }

  .page { max-width: 900px; margin: 0 auto; background: #fff; border: 1.6px solid #000; padding: 12px 14px 16px; }

  /* En-tête officiel */
  .head { border: 1.4px solid #000; padding: 9px 12px 7px; position: relative; }
  .head .brand { text-align: center; font-size: 25px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; }
  .head .activity { text-align: center; font-size: 16px; font-weight: 700; margin-top: 4px; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; }
  .head .place { text-align: center; font-size: 11.5px; font-weight: 700; margin-top: 4px; text-transform: uppercase; }
  .head .legal { text-align: center; font-size: 9.6px; font-weight: 700; margin-top: 2px; text-transform: uppercase; }
  .head .city { text-align: right; font-size: 12.5px; font-weight: 700; font-style: italic; margin-top: 7px; text-transform: uppercase; }
  .head .logo { position: absolute; top: 7px; left: 9px; width: 62px; height: 62px; object-fit: contain; }

  .doc-title { text-align: center; font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.1px; margin: 12px 0 3px; text-decoration: underline; text-underline-offset: 4px; }
  .doc-sub { text-align: center; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; }

  /* Identification */
  .meta { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  .meta td { border: 1.1px solid #000; padding: 3.5px 6px; font-size: 11.4px; }
  .meta td.k { font-weight: 700; text-transform: uppercase; width: 22%; background: #F2F2F2; }

  /* Chiffres clés */
  .kpis { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  .kpis td { border: 1.1px solid #000; padding: 5px 7px; font-size: 11.6px; width: 25%; vertical-align: top; }
  .kpis .l { font-size: 9.8px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
  .kpis .v { font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }

  /* Sections */
  .section { margin-bottom: 14px; break-inside: avoid; }
  .sec-title { display: flex; justify-content: space-between; gap: 10px; font-size: 12.8px; font-weight: 700; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; margin: 0 0 4px 2px; }
  .sec-note { font-size: 10.8px; font-style: italic; margin: 0 0 4px 2px; }

  table.data { width: 100%; border-collapse: collapse; }
  table.data th, table.data td { border: 1.1px solid #000; padding: 3.5px 5px; font-size: 11.4px; vertical-align: top; }
  table.data th { font-weight: 700; text-transform: uppercase; text-align: left; letter-spacing: .3px; }
  table.data thead { display: table-header-group; }
  table.data tr { break-inside: avoid; }
  .al-right, th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .al-center { text-align: center; }

  tr.r-category td { background: #E4E4E4; font-weight: 700; text-transform: uppercase; }
  tr.r-subheader td { background: #F0F0F0; font-weight: 700; }
  tr.r-detail td.first { padding-left: 18px; }
  tr.r-subtotal td { background: #F6F6F6; font-weight: 700; }
  tr.r-total td { background: #D9D9D9; font-weight: 700; font-size: 12px; }

  .pos, .neg, .accent { font-weight: 700; }
  .muted { color: #333; }

  .empty { border: 1.1px solid #000; padding: 8px; text-align: center; font-style: italic; font-size: 11.4px; }

  .foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 16px; break-inside: avoid; }
  .foot .printed { font-size: 10.5px; font-style: italic; }
  .foot .sign { text-align: center; font-size: 12px; font-weight: 700; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; padding-top: 34px; min-width: 140px; }

  .tag { margin-top: 10px; text-align: center; font-size: 9.5px; font-style: italic; }

  @media print {
    body { background: #fff; padding: 0; }
    .toolbar { display: none !important; }
    .page { border: none; max-width: none; padding: 0; }
    @page { size: A4; margin: 10mm; }
  }
`;

// ---------------------------------------------------------------- rendering
function renderTable(sec: PrintTableSection): string {
  const nCols = sec.cols.length;
  const headCells = sec.cols
    .map((c) => `<th class="${c.align === 'right' ? 'num' : c.align === 'center' ? 'al-center' : ''}">${esc(c.label)}</th>`)
    .join('');

  const body = sec.rows
    .map((r) => {
      const cls = r.variant ? `r-${r.variant}` : '';
      if (r.span && r.cells.length >= 2) {
        const last = r.cells[r.cells.length - 1];
        const firstAlign = sec.cols[0]?.align;
        return `<tr class="${cls}"><td colspan="${nCols - 1}" class="${firstAlign === 'right' ? 'num' : firstAlign === 'center' ? 'al-center' : ''}">${esc(r.cells[0])}</td><td class="num ${toneClass[r.tone || 'default']}">${esc(last)}</td></tr>`;
      }
      const tds = r.cells
        .map((cell, i) => {
          const align = sec.cols[i]?.align;
          const isLast = i === r.cells.length - 1;
          const first = i === 0 && r.variant === 'detail' ? 'first' : '';
          const alignCls = align === 'right' ? 'num' : align === 'center' ? 'al-center' : '';
          const toneCls = isLast && r.tone ? toneClass[r.tone] : '';
          return `<td class="${alignCls} ${first} ${toneCls}">${esc(cell)}</td>`;
        })
        .join('');
      return `<tr class="${cls}">${tds}</tr>`;
    })
    .join('');

  const table =
    sec.rows.length === 0
      ? `<div class="empty">${esc(sec.emptyLabel || '—')}</div>`
      : `<table class="data"><thead><tr>${headCells}</tr></thead><tbody>${body}</tbody></table>`;

  return `
    <div class="section">
      <div class="sec-title"><span>${esc(sec.title)}</span>${sec.headerTotal ? `<span>${esc(sec.headerTotal)}</span>` : ''}</div>
      ${sec.note ? `<div class="sec-note">${esc(sec.note)}</div>` : ''}
      ${table}
    </div>`;
}

export function printDetailedReport(doc: ReportDoc, store: StoreSettings, lang: Lang = 'fr') {
  const win = window.open('', '_blank', 'width=980,height=1040');
  if (!win) return;

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const printedOn = lang === 'ar' ? 'طُبع في' : 'Imprimé le';
  const printBtn = lang === 'ar' ? 'طباعة' : 'Imprimer';
  const closeBtn = lang === 'ar' ? 'إغلاق' : 'Fermer';

  const legal = [
    store.address ? `SIEGE SOCIAL : ${store.address}` : '',
    store.phone ? `TEL : ${store.phone}` : '',
  ].filter(Boolean).join('  ');
  const fiscal = [
    store.rc ? `R.C : ${store.rc}` : '',
    store.nif ? `NIF : ${store.nif}` : '',
    store.nis ? `NIS : ${store.nis}` : '',
    store.article ? `ART : ${store.article}` : '',
  ].filter(Boolean).join('  |  ');
  const city = headerCity(store);

  const metaHtml = doc.meta && doc.meta.length
    ? `<table class="meta">${doc.meta
        .map((m) => `<tr><td class="k">${esc(m.label)}</td><td>${esc(m.value)}</td></tr>`)
        .join('')}</table>`
    : '';

  const kpiCells = (doc.kpis ?? []).map(
    (k) => `<td><div class="l">${esc(k.label)}</div><div class="v ${k.tone || ''}">${esc(k.value)}</div></td>`
  );
  const kpiRows: string[] = [];
  for (let i = 0; i < kpiCells.length; i += 4) {
    const slice = kpiCells.slice(i, i + 4);
    while (slice.length < 4) slice.push('<td></td>');
    kpiRows.push(`<tr>${slice.join('')}</tr>`);
  }
  const kpisHtml = kpiRows.length ? `<table class="kpis">${kpiRows.join('')}</table>` : '';

  const sectionsHtml = doc.sections.map(renderTable).join('');

  win.document.write(`<!doctype html>
<html lang="${lang}" dir="${dir}">
  <head><meta charset="utf-8"/><title>${esc(doc.docTitle)}</title><style>${css}</style></head>
  <body>
    <div class="toolbar">
      <button onclick="window.print()">${printBtn}</button>
      <button class="ghost" onclick="window.close()">${closeBtn}</button>
    </div>
    <div class="page">
      <div class="head">
        ${store.logo ? `<img class="logo" src="${store.logo}" alt=""/>` : ''}
        <div class="brand">${esc(store.name || 'ALTECH PRODUCTION')}</div>
        ${store.description ? `<div class="activity">${esc(store.description)}</div>` : ''}
        ${store.activityPlace ? `<div class="place">LIEU D'ACTIVITE : ${esc(store.activityPlace)}</div>` : ''}
        ${legal ? `<div class="legal">${esc(legal)}</div>` : ''}
        ${fiscal ? `<div class="legal">${esc(fiscal)}</div>` : ''}
        <div class="city">${city ? `${esc(city)} LE ` : 'LE '}${esc(formatDate(new Date(), lang))}</div>
      </div>

      <div class="doc-title">${esc(doc.headTitle)}</div>
      <div class="doc-sub">${esc(doc.subtitle)}</div>

      ${metaHtml}
      ${kpisHtml}
      ${sectionsHtml}

      <div class="foot">
        <div class="printed">${printedOn} : ${esc(formatDateTime(new Date(), lang))}</div>
        <div class="sign">Signature</div>
      </div>
      ${store.socialMedia ? `<div class="tag">${esc(store.socialMedia)}</div>` : ''}
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>
  </body>
</html>`);
  win.document.close();
}
