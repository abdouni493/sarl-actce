import type { StoreSettings } from '@/types';
import { formatCurrency, formatDate } from './utils';

/* ============================================================================
 *  MODÈLE OFFICIEL DES DOCUMENTS IMPRIMÉS
 * ----------------------------------------------------------------------------
 *  Reproduction fidèle du bon de livraison manuscrit de l'entreprise :
 *
 *      ┌──────────────────────────────────────────────────────────┐
 *      │            SARL ACTCE LOKMANE            (souligné)      │
 *      │      FABRICATION DE BETON PRET A L'EMPLOI (souligné)     │
 *      │            LIEU D'ACTIVITE : BAHLI BLIDA                 │
 *      │  SIEGE SOCIAL : … W. DE BLIDA  TEL : 0556-58-53-42       │
 *      │                                     BLIDA LE 05/04/2026  │
 *      └──────────────────────────────────────────────────────────┘
 *                        BON DE LIVRAISON            (souligné)
 *        DOIT : HARAZI OULED AICHE
 *      ┌──────┬─────────────┬────────┬──────────┬────────┬────────┐
 *      │ DATE │ DESIGNATION │ DOSAGE │ QUANTITE │  P.U.  │ TOTAL  │
 *      ├──────┼─────────────┼────────┼──────────┼────────┼────────┤
 *      │ …    │ BETON       │  350   │   74,5   │ 8700,00│648150,0│
 *      ├──────┴─────────────┴────────┴──────────┼────────┼────────┤
 *      │                                TOTAL HT│        │  …     │
 *      │                               VERSEMENT│        │  …     │
 *      │                                LE REST │        │  …     │
 *      └────────────────────────────────────────┴────────┴────────┘
 *        VERSEMENT DE 600 000 DA LE 09/06/2026
 *        VERSEMENT DE 400 000 DA LE 13/06/2026
 *                                                        SIGNATURE
 *
 *  TOUS les documents de l'application (bon de livraison, bon de commande,
 *  compte rendu, facture de vente, reçu de versement) sont rendus par ce même
 *  moteur : seuls le titre, les colonnes et le bloc de totaux changent.
 * ========================================================================== */

export type Align = 'left' | 'center' | 'right';

export interface DocColumn {
  label: string;
  align?: Align;
  /** Largeur CSS optionnelle (ex : '9%'). */
  width?: string;
}

export interface DocRow {
  cells: (string | number)[];
  /** Ligne de sous-total / regroupement — fond gris et texte gras. */
  variant?: 'normal' | 'group' | 'subtotal';
  /** La première cellule occupe toutes les colonnes sauf la dernière. */
  span?: boolean;
}

export interface DocTotal {
  label: string;
  value: string;
  /** Ligne mise en évidence (TOTAL T.T.C, LE REST…). */
  strong?: boolean;
}

export interface DocTable {
  /** Titre de section, imprimé au-dessus du tableau (facultatif). */
  title?: string;
  columns: DocColumn[];
  rows: DocRow[];
  /** Bloc de totaux collé au pied du tableau, aligné sur ses 2 dernières colonnes. */
  totals?: DocTotal[];
  emptyLabel?: string;
  note?: string;
}

export interface DocData {
  /** Titre encadré et souligné : BON DE LIVRAISON, BON DE COMMANDE… */
  title: string;
  /** Date portée par la mention « <VILLE> LE jj/mm/aaaa ». */
  docDate: string;
  /** Libellé du destinataire : DOIT, FOURNISSEUR, EMPLOYÉ… */
  doitLabel?: string;
  doitName?: string;
  /** Identifiants du destinataire (adresse, R.C, NIF, NIS, article, tél). */
  doitLines?: string[];
  /** Références du document (N°, commande liée, chauffeur…) — sous la date. */
  metaLines?: string[];
  /** Mentions encadrées (LIVRAISON PARTIELLE, ANCIENNE COMMANDE…). */
  stamps?: { label: string; tone?: 'ok' | 'warn' }[];
  tables: DocTable[];
  /** Montant en toutes lettres — encadré sous les tableaux. */
  amountInWords?: string;
  /** Lignes libres en bas à gauche : « VERSEMENT DE … DA LE … ». */
  footNotes?: string[];
  /** Observations encadrées. */
  observations?: string;
  /** Cartouches de signature — « SIGNATURE » seul par défaut. */
  signatures?: string[];
  /** Nom du fichier / onglet d'impression. */
  fileName: string;
}

/* ------------------------------------------------------------------ helpers */

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

/** « VERSEMENT DE 600 000,00 DA LE 09/06/2026 » — ligne de pied de document. */
export function versementLine(amount: number, date: string): string {
  return `VERSEMENT DE ${formatCurrency(amount)} LE ${formatDate(date)}`;
}

/* ---------------------------------------------------------------- feuille */

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Times New Roman', Times, Georgia, serif;
    color: #000; background: #E9EDF0; padding: 16px;
    font-size: 12.5px; line-height: 1.35;
  }

  .toolbar { max-width: 830px; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 9px; }
  .toolbar button { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; border: 2px solid #000; border-radius: 4px; padding: 8px 20px; background: #000; color: #fff; }
  .toolbar button.ghost { background: #fff; color: #000; }

  .sheet { max-width: 830px; margin: 0 auto; background: #fff; border: 1.6px solid #000; padding: 12px 14px 16px; }

  /* ---- En-tête encadré, tout centré, façon papier à en-tête ---- */
  .head { border: 1.4px solid #000; padding: 9px 12px 7px; margin-bottom: 4px; position: relative; }
  .head .brand {
    text-align: center; font-size: 25px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px;
  }
  .head .activity {
    text-align: center; font-size: 16px; font-weight: 700; letter-spacing: .3px; margin-top: 4px;
    text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px;
  }
  .head .place { text-align: center; font-size: 11.5px; font-weight: 700; margin-top: 4px; text-transform: uppercase; letter-spacing: .2px; }
  .head .legal { text-align: center; font-size: 9.6px; font-weight: 700; margin-top: 2px; text-transform: uppercase; letter-spacing: .1px; }
  .head .fiscal { text-align: center; font-size: 9.6px; font-weight: 700; margin-top: 2px; text-transform: uppercase; }
  .head .city { text-align: right; font-size: 12.5px; font-weight: 700; font-style: italic; margin-top: 7px; text-transform: uppercase; }
  .head .logo { position: absolute; top: 7px; left: 9px; width: 62px; height: 62px; object-fit: contain; }

  /* ---- Titre du document ---- */
  .doc-title {
    text-align: center; font-size: 18px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1.1px; margin: 12px 0 4px;
    text-decoration: underline; text-underline-offset: 4px;
  }
  .meta { text-align: right; font-size: 11px; font-weight: 700; text-transform: uppercase; line-height: 1.55; margin-bottom: 6px; }

  /* ---- Bloc DOIT ---- */
  .doit { font-size: 13px; font-weight: 700; font-style: italic; text-transform: uppercase; margin: 6px 0 8px 4px; }
  .doit .lbl { text-decoration: underline; text-underline-offset: 2px; }
  .doit .sub { display: block; font-style: normal; font-size: 11px; font-weight: 700; margin-top: 2px; }

  /* ---- Tableaux ---- */
  .sec-title { font-size: 12.5px; font-weight: 700; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; margin: 12px 0 4px 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  th, td { border: 1.1px solid #000; padding: 3.5px 5px; font-size: 11.6px; vertical-align: middle; }
  th { font-weight: 700; text-transform: uppercase; text-align: center; letter-spacing: .3px; background: #fff; }
  td { font-weight: 400; }
  td.l, th.l { text-align: left; }
  td.c, th.c { text-align: center; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  tr.group td { font-weight: 700; text-transform: uppercase; background: #EDEDED; }
  tr.subtotal td { font-weight: 700; background: #F6F6F6; }
  tr { break-inside: avoid; }
  .empty { text-align: center; font-style: italic; padding: 8px; }

  /* ---- Totaux collés au pied du tableau ---- */
  .tot-label { text-align: right; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
  .tot-value { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
  tr.grand td { background: #E4E4E4; font-size: 12.6px; }

  /* ---- Montant en lettres ---- */
  .words { border: 1.1px solid #000; padding: 6px 9px; font-size: 11.5px; margin: 8px 0; }
  .words b { text-transform: uppercase; font-size: 10px; letter-spacing: .5px; }
  .words i { font-style: italic; font-weight: 700; }

  .obs { border: 1.1px solid #000; padding: 6px 9px; font-size: 11.5px; margin: 8px 0; }
  .obs b { text-transform: uppercase; font-size: 10px; letter-spacing: .5px; }

  .stamps { margin: 8px 0 2px; }
  .stamp { display: inline-block; border: 1.4px solid #000; padding: 2px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; margin-right: 8px; }
  .stamp.warn { background: #EDEDED; }

  /* ---- Pied : versements à gauche, signature à droite ---- */
  .foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; margin-top: 14px; break-inside: avoid; }
  .foot .notes { font-size: 11.5px; font-weight: 700; text-transform: uppercase; line-height: 1.7; }
  .foot .signs { display: flex; gap: 26px; }
  .foot .sign { text-align: center; font-size: 12px; font-weight: 700; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; padding-top: 34px; min-width: 120px; }

  .tag { margin-top: 12px; text-align: center; font-size: 9.5px; font-style: italic; }

  @media print {
    body { background: #fff; padding: 0; }
    .toolbar { display: none !important; }
    .sheet { border: none; max-width: none; padding: 0; }
    @page { size: A4 portrait; margin: 10mm; }
  }
`;

function headBlock(store: StoreSettings, docDate: string): string {
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

  const city = (store.city || '').trim() || firstWord(store.address) || '';

  return `
    <div class="head">
      ${store.logo ? `<img class="logo" src="${store.logo}" alt=""/>` : ''}
      <div class="brand">${esc(store.name || 'ALTECH PRODUCTION')}</div>
      ${store.description ? `<div class="activity">${esc(store.description)}</div>` : ''}
      ${store.activityPlace ? `<div class="place">LIEU D'ACTIVITE : ${esc(store.activityPlace)}</div>` : ''}
      ${legal ? `<div class="legal">${esc(legal)}</div>` : ''}
      ${fiscal ? `<div class="fiscal">${esc(fiscal)}</div>` : ''}
      <div class="city">${city ? `${esc(city)} LE ` : 'LE '}${esc(formatDate(docDate))}</div>
    </div>`;
}

/** Dernier mot significatif de l'adresse — sert de ville par défaut. */
function firstWord(address?: string): string {
  if (!address) return '';
  const parts = address.split(/[,\-–]/).map((p) => p.trim()).filter(Boolean);
  return (parts[parts.length - 1] || '').toUpperCase();
}

function alignClass(a?: Align): string {
  return a === 'right' ? 'r' : a === 'center' ? 'c' : 'l';
}

function tableHtml(t: DocTable): string {
  const cols = t.columns;
  const head = `<tr>${cols
    .map((c) => `<th class="${alignClass(c.align)}"${c.width ? ` style="width:${c.width}"` : ''}>${esc(c.label)}</th>`)
    .join('')}</tr>`;

  const body = t.rows.length
    ? t.rows
        .map((r) => {
          const cls = r.variant && r.variant !== 'normal' ? ` class="${r.variant}"` : '';
          if (r.span) {
            const last = r.cells[r.cells.length - 1];
            return `<tr${cls}><td class="l" colspan="${cols.length - 1}">${r.cells[0]}</td><td class="${alignClass(
              cols[cols.length - 1].align
            )}">${last}</td></tr>`;
          }
          return `<tr${cls}>${r.cells
            .map((cell, i) => `<td class="${alignClass(cols[i]?.align)}">${cell}</td>`)
            .join('')}</tr>`;
        })
        .join('')
    : `<tr><td class="empty" colspan="${cols.length}">${esc(t.emptyLabel || 'Aucune ligne')}</td></tr>`;

  // Les totaux se collent aux DEUX dernières colonnes, comme sur le modèle.
  const totals = (t.totals ?? [])
    .map(
      (x) => `<tr${x.strong ? ' class="grand"' : ''}>
        <td class="tot-label" colspan="${Math.max(1, cols.length - 1)}">${esc(x.label)}</td>
        <td class="tot-value">${x.value}</td>
      </tr>`
    )
    .join('');

  return `
    ${t.title ? `<div class="sec-title">${esc(t.title)}</div>` : ''}
    <table>
      <thead>${head}</thead>
      <tbody>${body}</tbody>
      ${totals ? `<tfoot>${totals}</tfoot>` : ''}
    </table>
    ${t.note ? `<div class="obs">${esc(t.note)}</div>` : ''}`;
}

/**
 * Rend et ouvre un document officiel dans une fenêtre d'impression.
 * Tous les modèles de l'application passent par ici : l'entreprise a un seul
 * papier à en-tête, quel que soit le document.
 */
export function printOfficialDocument(data: DocData, store: StoreSettings) {
  const win = window.open('', '_blank', 'width=880,height=1040');
  if (!win) return;

  const signatures = data.signatures?.length ? data.signatures : ['Signature'];

  win.document.write(`<!doctype html>
<html lang="fr">
  <head><meta charset="utf-8"/><title>${esc(data.fileName)}</title><style>${CSS}</style></head>
  <body>
    <div class="toolbar">
      <button onclick="window.print()">Imprimer</button>
      <button class="ghost" onclick="window.close()">Fermer</button>
    </div>
    <div class="sheet">
      ${headBlock(store, data.docDate)}
      <div class="doc-title">${esc(data.title)}</div>
      ${data.metaLines?.length ? `<div class="meta">${data.metaLines.map(esc).join('<br/>')}</div>` : ''}
      ${
        data.doitName
          ? `<div class="doit"><span class="lbl">${esc(data.doitLabel || 'DOIT')} :</span> ${esc(data.doitName)}
               ${data.doitLines?.length ? `<span class="sub">${data.doitLines.map(esc).join(' &nbsp;·&nbsp; ')}</span>` : ''}
             </div>`
          : ''
      }
      ${data.tables.map(tableHtml).join('')}
      ${
        data.amountInWords
          ? `<div class="words"><b>Arrêtée la présente à la somme de :</b><br/><i>${esc(data.amountInWords)}</i></div>`
          : ''
      }
      ${data.observations ? `<div class="obs"><b>Observations :</b> ${esc(data.observations)}</div>` : ''}
      ${
        data.stamps?.length
          ? `<div class="stamps">${data.stamps
              .map((s) => `<span class="stamp${s.tone === 'warn' ? ' warn' : ''}">${esc(s.label)}</span>`)
              .join('')}</div>`
          : ''
      }
      <div class="foot">
        <div class="notes">${(data.footNotes ?? []).map(esc).join('<br/>')}</div>
        <div class="signs">${signatures.map((s) => `<div class="sign">${esc(s)}</div>`).join('')}</div>
      </div>
      ${store.socialMedia ? `<div class="tag">${esc(store.socialMedia)}</div>` : ''}
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print();},350);};<\/script>
  </body>
</html>`);
  win.document.close();
}
