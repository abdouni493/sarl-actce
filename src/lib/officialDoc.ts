import type { StoreSettings } from '@/types';
import { formatCurrency, formatDate } from './utils';

/* ============================================================================
 *  MODÈLE OFFICIEL DES DOCUMENTS IMPRIMÉS
 * ----------------------------------------------------------------------------
 *  Papier à en-tête unique de l'entreprise : coordonnées et identifiants à
 *  GAUCHE, raison sociale + activité au MILIEU, logo à DROITE.
 *
 *      ┌──────────────────────────────────────────────────────────┐
 *      │ LIEU D'ACTIVITE : BAHLI                                  │
 *      │ SIEGE SOCIAL : …      SARL ACTCE LOKMANE        ┌──────┐ │
 *      │ TEL : 0556-58-53-42   FABRICATION DE BETON      │ LOGO │ │
 *      │ R.C : … NIF : …          PRET A L'EMPLOI        └──────┘ │
 *      │ NIS : … ART : …                                          │
 *      │                                     BLIDA LE 05/04/2026  │
 *      └──────────────────────────────────────────────────────────┘
 *                        BON DE LIVRAISON            (souligné)
 *        DOIT : HARAZI OULED AICHE
 *      ┌─────────────┬──────────┬────────────┬──────────────────┐
 *      │ DESIGNATION │ QUANTITE │ PRIX UNIT. │      TOTAL       │
 *      ├─────────────┼──────────┼────────────┼──────────────────┤
 *      │ BETON       │   74,5   │  8 700,00  │    648 150,00    │
 *      ├─────────────┴──────────┴────────────┼──────────────────┤
 *      │                             TOTAL HT│        …         │
 *      │                                  TVA│        …         │
 *      │                            TOTAL TTC│        …         │
 *      │                            VERSEMENT│        …         │
 *      │                              LE REST│        …         │
 *      └─────────────────────────────────────┴──────────────────┘
 *                                                        SIGNATURE
 *
 *  TOUS les documents de l'application (bon de livraison, bon de commande,
 *  compte rendu, facture de vente, reçu de versement) sont rendus par ce même
 *  moteur : seuls le titre, les colonnes et le bloc de totaux changent.
 *  Les textes sont volontairement grands et en gras : les bons sont lus sur
 *  chantier, souvent sur une photocopie.
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
    font-size: 15px; font-weight: 700; line-height: 1.4;
  }

  .toolbar { max-width: 860px; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 9px; }
  .toolbar button { font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; border: 2px solid #000; border-radius: 4px; padding: 9px 22px; background: #000; color: #fff; }
  .toolbar button.ghost { background: #fff; color: #000; }

  .sheet { max-width: 860px; margin: 0 auto; background: #fff; border: 1.6px solid #000; padding: 12px 14px 16px; }

  /* ---- En-tête : informations à GAUCHE · raison sociale au MILIEU · logo à DROITE ---- */
  .head { border: 1.6px solid #000; padding: 10px 12px 8px; margin-bottom: 4px; }
  .head .row { display: flex; align-items: center; gap: 12px; }
  .head .info {
    flex: 0 0 30%; font-size: 12.5px; font-weight: 700; line-height: 1.55;
    text-transform: uppercase; word-break: break-word;
  }
  .head .center { flex: 1 1 auto; text-align: center; }
  .head .logo-box { flex: 0 0 auto; width: 100px; text-align: right; }
  .head .logo { width: 96px; height: 96px; object-fit: contain; }
  .head .brand {
    font-size: 30px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; text-decoration: underline; text-underline-offset: 4px;
  }
  .head .activity {
    font-size: 19px; font-weight: 700; letter-spacing: .3px; margin-top: 5px;
    text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px;
  }
  .head .city { text-align: right; font-size: 15px; font-weight: 700; font-style: italic; margin-top: 8px; text-transform: uppercase; }

  /* ---- Titre du document ---- */
  .doc-title {
    text-align: center; font-size: 23px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1.2px; margin: 14px 0 5px;
    text-decoration: underline; text-underline-offset: 4px;
  }
  .meta { text-align: right; font-size: 14px; font-weight: 700; text-transform: uppercase; line-height: 1.6; margin-bottom: 7px; }

  /* ---- Bloc DOIT ---- */
  .doit { font-size: 16.5px; font-weight: 700; font-style: italic; text-transform: uppercase; margin: 7px 0 9px 4px; }
  .doit .lbl { text-decoration: underline; text-underline-offset: 2px; }
  .doit .sub { display: block; font-style: normal; font-size: 14px; font-weight: 700; margin-top: 3px; }

  /* ---- Tableaux ---- */
  .sec-title { font-size: 16px; font-weight: 700; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; margin: 14px 0 5px 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 7px; }
  th, td { border: 1.2px solid #000; padding: 6px 7px; font-size: 14.5px; font-weight: 700; vertical-align: middle; }
  th { text-transform: uppercase; text-align: center; letter-spacing: .3px; background: #fff; font-size: 14.5px; }
  td.l, th.l { text-align: left; }
  td.c, th.c { text-align: center; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  tr.group td { text-transform: uppercase; background: #EDEDED; }
  tr.subtotal td { background: #F6F6F6; }
  tr { break-inside: avoid; }
  .empty { text-align: center; font-style: italic; padding: 10px; font-size: 14.5px; }

  /* ---- Totaux collés au pied du tableau ---- */
  .tot-label { text-align: right; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
  .tot-value { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
  tr.grand td { background: #E4E4E4; font-size: 16.5px; }

  /* ---- Montant en lettres ---- */
  .words { border: 1.2px solid #000; padding: 8px 10px; font-size: 14.5px; margin: 10px 0; }
  .words b { text-transform: uppercase; font-size: 13px; letter-spacing: .5px; }
  .words i { font-style: italic; font-weight: 700; }

  .obs { border: 1.2px solid #000; padding: 8px 10px; font-size: 14.5px; margin: 10px 0; }
  .obs b { text-transform: uppercase; font-size: 13px; letter-spacing: .5px; }

  .stamps { margin: 10px 0 2px; }
  .stamp { display: inline-block; border: 1.5px solid #000; padding: 3px 12px; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; margin-right: 8px; }
  .stamp.warn { background: #EDEDED; }

  /* ---- Pied : versements à gauche, signature à droite ---- */
  .foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; margin-top: 16px; break-inside: avoid; }
  .foot .notes { font-size: 14.5px; font-weight: 700; text-transform: uppercase; line-height: 1.75; }
  .foot .signs { display: flex; gap: 26px; }
  .foot .sign { text-align: center; font-size: 15px; font-weight: 700; text-transform: uppercase; text-decoration: underline; text-underline-offset: 3px; padding-top: 38px; min-width: 140px; }

  .tag { margin-top: 12px; text-align: center; font-size: 12.5px; font-style: italic; font-weight: 700; }

  @media print {
    body { background: #fff; padding: 0; }
    .toolbar { display: none !important; }
    .sheet { border: none; max-width: none; padding: 0; }
    @page { size: A4 portrait; margin: 9mm; }
  }
`;

function headBlock(store: StoreSettings, docDate: string): string {
  // Colonne de GAUCHE : toutes les coordonnées et identifiants de l'entreprise.
  const info = [
    store.activityPlace ? `LIEU D'ACTIVITE : ${store.activityPlace}` : '',
    store.address ? `SIEGE SOCIAL : ${store.address}` : '',
    store.phone ? `TEL : ${store.phone}` : '',
    store.email ? `EMAIL : ${store.email}` : '',
    store.rc ? `R.C : ${store.rc}` : '',
    store.nif ? `NIF : ${store.nif}` : '',
    store.nis ? `NIS : ${store.nis}` : '',
    store.article ? `ART : ${store.article}` : '',
  ].filter(Boolean);

  const city = (store.city || '').trim() || firstWord(store.address) || '';

  return `
    <div class="head">
      <div class="row">
        <div class="info">${info.map(esc).join('<br/>')}</div>
        <div class="center">
          <div class="brand">${esc(store.name || 'ALTECH PRODUCTION')}</div>
          ${store.description ? `<div class="activity">${esc(store.description)}</div>` : ''}
        </div>
        <div class="logo-box">
          ${store.logo ? `<img class="logo" src="${store.logo}" alt=""/>` : ''}
        </div>
      </div>
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
