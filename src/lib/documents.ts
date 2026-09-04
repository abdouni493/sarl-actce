import type { StoreSettings, PaymentMethod } from '@/types';
import { formatCurrency, formatDate, formatDateTime, paymentMethodLabel } from './utils';
import { printDocument } from './print';
import { amountInWords } from './invoicePrint';

/** Identifiants fiscaux d'un client — imprimés dans le bloc « DOIT ». */
export interface ClientFiscal {
  name: string;
  phone?: string;
  address?: string;
  rc?: string;
  nif?: string;
  nis?: string;
  article?: string;
}

/* ============================================================================
 *  Documents imprimables — reçus de règlement, bons de livraison,
 *  bons de commande et fiches de production.
 *  Tous partagent le même en-tête (logo + coordonnées du magasin).
 * ========================================================================== */

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Arial, 'Segoe UI', sans-serif; color: #000; background: #fff; font-size: 14px; font-weight: 600; line-height: 1.5; }
  .sheet { max-width: 800px; margin: 0 auto; border: 2.5px solid #000; border-radius: 10px; overflow: hidden; }

  /* En-tête : logo agrandi, coordonnées en gras */
  .head { display: flex; justify-content: space-between; gap: 20px; padding: 18px 22px; border-bottom: 3px solid #000; }
  .brand-name { font-size: 27px; font-weight: 900; color: #000; letter-spacing: -.3px; text-transform: uppercase; }
  .brand-tag { font-size: 13px; font-weight: 700; font-style: italic; color: #222; margin-top: 2px; }
  .brand-meta { font-size: 13px; font-weight: 700; color: #000; margin-top: 8px; line-height: 1.75; }
  .doc-title { font-size: 21px; font-weight: 900; background: #000; color: #fff; padding: 8px 18px; border-radius: 4px; display: inline-block; letter-spacing: 1.4px; }
  .doc-meta { text-align: right; font-size: 14px; font-weight: 700; color: #000; line-height: 1.8; margin-top: 9px; }
  .doc-meta strong { font-weight: 900; }
  .logo { width: 112px; height: 112px; border: 3px solid #000; border-radius: 12px; object-fit: contain; background: #fff; padding: 3px; flex-shrink: 0; }
  .content { padding: 20px 22px 24px; }

  /* Bloc partie (client / fournisseur) */
  .party { border: 2px solid #000; border-left: 7px solid #000; border-radius: 6px; padding: 11px 15px; margin-bottom: 16px; font-size: 14px; font-weight: 700; line-height: 1.75; background: #f4f4f4; color: #000; }
  .party .lbl { font-size: 11.5px; text-transform: uppercase; letter-spacing: 1.2px; color: #000; font-weight: 900; }
  .party strong { font-weight: 900; color: #000; }

  /* Tableaux — texte noir, gras, lisible */
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 16px; color: #000; }
  th { background: #000; color: #fff; padding: 10px 11px; text-align: left; border: 1.5px solid #000; font-weight: 900; font-size: 13px; text-transform: uppercase; letter-spacing: .5px; }
  td { padding: 10px 11px; border: 1.5px solid #333; font-weight: 700; color: #000; }
  tbody tr:nth-child(even) td { background: #f4f4f4; }
  tfoot th { background: #000; }
  tr { break-inside: avoid; }
  .right { text-align: right; font-variant-numeric: tabular-nums; }
  .center { text-align: center; font-variant-numeric: tabular-nums; }

  /* Totaux */
  .totals { width: 340px; margin-left: auto; border: 2.5px solid #000; border-radius: 6px; overflow: hidden; font-size: 15px; font-weight: 800; color: #000; }
  .totals div { display: flex; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1.5px solid #333; }
  .totals div:last-child { border-bottom: 0; }
  .totals strong { font-weight: 900; font-variant-numeric: tabular-nums; }
  .totals .grand { background: #000; color: #fff; font-weight: 900; font-size: 16px; }
  .totals .ok { background: #d8f2e2; font-weight: 900; }
  .totals .due { background: #fbdde3; font-weight: 900; }
  .totals .tva { background: #f4f4f4; font-weight: 900; }

  /* Totaux + montant en lettres côte à côte (façon facture SARL) */
  .totwrap { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
  .words { flex: 1; border: 2px dashed #000; border-radius: 6px; padding: 12px 15px; font-size: 13.5px; color: #000; background: #fafafa; }
  .words .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #000; font-weight: 900; margin-bottom: 4px; }
  .words .v { font-weight: 900; font-style: italic; color: #000; }

  .note { border: 2px dashed #000; border-radius: 6px; padding: 11px 15px; font-size: 13.5px; font-weight: 700; color: #000; margin-bottom: 16px; background: #fafafa; }
  .signs { display: flex; justify-content: space-between; gap: 20px; margin-top: 30px; font-size: 13.5px; text-align: center; break-inside: avoid; }
  .sign { width: 46%; border: 2px solid #000; border-radius: 6px; padding: 12px; height: 96px; font-weight: 900; color: #000; text-transform: uppercase; letter-spacing: .4px; }
  .foot { margin-top: 20px; padding-top: 12px; border-top: 2px dashed #000; text-align: center; font-size: 12.5px; font-weight: 700; color: #222; }
  .stamp { display: inline-block; border: 3px solid #0a7d43; color: #0a7d43; border-radius: 6px; padding: 6px 16px; font-weight: 900; transform: rotate(-3deg); font-size: 15px; letter-spacing: .6px; }
  .stamp.warn { border-color: #a33d00; color: #a33d00; }
  h3 { color: #000; font-weight: 900; }

  @media print {
    body { font-size: 13.5px; }
    .sheet { border: none; border-radius: 0; max-width: none; }
    @page { size: A4; margin: 9mm; }
  }
`;

function header(store: StoreSettings, title: string, metaLines: string[]): string {
  const logo = store.logo
    ? `<img class="logo" src="${store.logo}" alt="logo"/>`
    : `<div class="logo" style="display:flex;align-items:center;justify-content:center;font-size:52px;">🏗️</div>`;
  return `
    <div class="head">
      <div style="display:flex;gap:16px;align-items:flex-start;">
        ${logo}
        <div>
          <div class="brand-name">${esc(store.name || 'ALTECH PRODUCTION')}</div>
          ${store.description ? `<div class="brand-tag">${esc(store.description)}</div>` : ''}
          <div class="brand-meta">
            ${store.address ? `📍 ${esc(store.address)}<br/>` : ''}
            ${store.phone ? `📞 ${esc(store.phone)}` : ''}${store.email ? ` · ✉️ ${esc(store.email)}` : ''}
            ${store.nif || store.nis || store.rc
              ? `<br/>${store.nif ? `NIF: ${esc(store.nif)} ` : ''}${store.nis ? `| NIS: ${esc(store.nis)} ` : ''}${store.rc ? `| RC: ${esc(store.rc)}` : ''}`
              : ''}
          </div>
        </div>
      </div>
      <div style="text-align:right;">
        <div class="doc-title">${esc(title)}</div>
        <div class="doc-meta">${metaLines.join('<br/>')}</div>
      </div>
    </div>`;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

function wrap(inner: string): string {
  return `<style>${BASE_CSS}</style><div class="sheet">${inner}</div>`;
}

/**
 * Bloc « DOIT » — le client à qui le document est adressé, avec ses
 * identifiants fiscaux (R.C, NIF, NIS, N° Article) tels qu'ils figurent sur
 * les factures officielles algériennes.
 */
function doitBlock(client: ClientFiscal, label = 'DOIT'): string {
  const fiscal = [
    client.address ? `<span class="lbl">Adresse :</span> ${esc(client.address)}` : '',
    client.rc ? `<span class="lbl">R.C N° :</span> <strong>${esc(client.rc)}</strong>` : '',
    client.nif ? `<span class="lbl">NIF :</span> <strong>${esc(client.nif)}</strong>` : '',
    client.nis ? `<span class="lbl">NIS :</span> <strong>${esc(client.nis)}</strong>` : '',
    client.article ? `<span class="lbl">N° Article :</span> <strong>${esc(client.article)}</strong>` : '',
    client.phone ? `<span class="lbl">Tél :</span> ${esc(client.phone)}` : '',
  ].filter(Boolean).join('<br/>');

  return `
    <div class="party">
      <div class="lbl">${esc(label)}</div>
      <strong style="font-size:17px;">${esc(client.name)}</strong>
      ${fiscal ? `<br/>${fiscal}` : ''}
    </div>`;
}

/** Bloc de totaux HT / TVA / TTC + montant en lettres, façon facture SARL. */
function totalsTTC(opts: {
  ht: number; tvaRate?: number; tvaAmount?: number; ttc: number;
  paid?: number; rest?: number; showPaid?: boolean;
}): string {
  const hasTva = !!opts.tvaAmount && opts.tvaAmount > 0;
  return `
    <div class="totwrap">
      <div class="words">
        <div class="lbl">Arrêtée la présente à la somme de</div>
        <div class="v">${esc(amountInWords(opts.ttc))}</div>
      </div>
      <div class="totals" style="margin:0;">
        <div><span>TOTAL H.T</span><strong>${formatCurrency(opts.ht)}</strong></div>
        ${hasTva ? `<div class="tva"><span>TVA ${esc(opts.tvaRate ?? 19)} %</span><strong>${formatCurrency(opts.tvaAmount as number)}</strong></div>` : ''}
        <div class="grand"><span>TOTAL T.T.C</span><strong>${formatCurrency(opts.ttc)}</strong></div>
        ${opts.showPaid ? `<div class="ok"><span>Versé / Acompte</span><strong>${formatCurrency(opts.paid ?? 0)}</strong></div>` : ''}
        ${opts.showPaid ? `<div class="${(opts.rest ?? 0) > 0 ? 'due' : 'grand'}"><span>Reste à payer</span><strong>${formatCurrency(opts.rest ?? 0)}</strong></div>` : ''}
      </div>
    </div>`;
}

/** Cartouche de signatures — « Le client » / « Cachet et signature de l'entreprise ». */
function signBlock(): string {
  return `
    <div class="signs">
      <div class="sign">Le client</div>
      <div class="sign">Cachet &amp; signature de l'entreprise</div>
    </div>`;
}

/* -------------------------------------------------------- reçu de règlement */

export interface PaymentReceiptData {
  kind: 'client' | 'supplier';
  receiptNumber: string;
  partyName: string;
  partyPhone?: string;
  amount: number;
  paidAt: string;          // ISO datetime
  notes?: string;
  /** Mode de règlement — espèces, chèque bancaire ou virement bancaire. */
  method?: PaymentMethod;
  chequeNumber?: string;
  virementNumber?: string;
  bankName?: string;
  totalDebt: number;
  totalPaid: number;
  restAmount: number;
}

export function printPaymentReceipt(data: PaymentReceiptData, store: StoreSettings) {
  const isClient = data.kind === 'client';
  const title = isClient ? 'REÇU DE VERSEMENT CLIENT' : 'REÇU DE RÈGLEMENT FOURNISSEUR';
  const partyLabel = isClient ? 'Client' : 'Fournisseur';
  const wording = isClient
    ? 'Reçu de la part de'
    : 'Versé à';
  const methodLabel = paymentMethodLabel(data);

  const html = wrap(`
    ${header(store, title, [
      `<strong>N° ${esc(data.receiptNumber)}</strong>`,
      `Date : ${esc(formatDateTime(data.paidAt))}`,
    ])}
    <div class="content">
      <div class="party">
        <div class="lbl">${partyLabel}</div>
        <strong style="font-size:15px;">${esc(data.partyName)}</strong>
        ${data.partyPhone ? `<br/>📞 ${esc(data.partyPhone)}` : ''}
      </div>

      <p style="font-size:15px;font-weight:700;margin-bottom:16px;">
        ${wording} <strong>${esc(data.partyName)}</strong> la somme de
        <strong style="font-size:19px;">${formatCurrency(data.amount)}</strong>
        le ${esc(formatDateTime(data.paidAt))},
        par <strong>${esc(methodLabel)}</strong>.
      </p>

      <div class="party" style="background:#fff;">
        <div class="lbl">Mode de règlement</div>
        <strong style="font-size:16px;">${esc(methodLabel)}</strong>
        ${data.method === 'cheque' && data.chequeNumber
          ? `<br/><span class="lbl">N° de chèque :</span> <strong>${esc(data.chequeNumber)}</strong>` : ''}
        ${data.method === 'virement' && data.virementNumber
          ? `<br/><span class="lbl">N° de virement :</span> <strong>${esc(data.virementNumber)}</strong>` : ''}
        ${data.method !== 'especes' && data.bankName
          ? `<br/><span class="lbl">Banque :</span> <strong>${esc(data.bankName)}</strong>` : ''}
      </div>

      ${data.notes ? `<div class="note"><strong>Note :</strong> ${esc(data.notes)}</div>` : ''}

      <div class="totals">
        <div><span>Dette totale</span><strong>${formatCurrency(data.totalDebt)}</strong></div>
        <div><span>${isClient ? 'Versement de ce jour' : 'Montant réglé ce jour'}</span><strong>${formatCurrency(data.amount)}</strong></div>
        <div class="ok"><span>Total payé</span><strong>${formatCurrency(data.totalPaid)}</strong></div>
        <div class="${data.restAmount > 0 ? 'due' : 'grand'}">
          <span>Reste à payer</span><strong>${formatCurrency(data.restAmount)}</strong>
        </div>
      </div>

      <div style="margin-top:18px;">
        <span class="stamp ${data.restAmount > 0 ? 'warn' : ''}">
          ${data.restAmount > 0 ? 'VERSEMENT PARTIEL' : 'DETTE SOLDÉE'}
        </span>
      </div>

      <div class="signs">
        <div class="sign">Signature ${partyLabel}</div>
        <div class="sign">Cachet &amp; Signature Entreprise</div>
      </div>
      <div class="foot">${esc(store.socialMedia || '')} — Merci de votre confiance.</div>
    </div>`);

  printDocument(html, `Recu_${data.receiptNumber}`);
}

/* ---------------------------------------------------------- bon de livraison */

export interface DeliveryNoteLine {
  productName: string;
  /** Quantité commandée par le client. */
  ordered: number;
  /** Quantité remise lors de CETTE livraison. */
  deliveredNow: number;
  /** Quantité remise depuis le début, toutes livraisons confondues. */
  deliveredTotal: number;
  unit?: string;
  /** Prix unitaire de la ligne de commande. */
  unitPrice: number;
}

export interface DeliveryNoteData {
  reference: string;
  commandReference: string;
  /** N° de bon de commande saisi manuellement sur la commande. */
  bonNumber?: string;
  clientName: string;
  clientPhone?: string;
  /** Adresse de livraison saisie sur la commande. */
  clientAddress?: string;
  /** Identifiants fiscaux du client (bloc DOIT). */
  clientRc?: string;
  clientNif?: string;
  clientNis?: string;
  clientArticle?: string;
  /** Lieu réellement livré pour ce bon. */
  location?: string;
  deliveredAt: string;
  notes?: string;
  /** Chauffeur qui effectue la livraison + immatriculation (facultative). */
  driverName?: string;
  driverPlate?: string;
  /** Ancienne livraison (commande ancienne). */
  historical?: boolean;
  lines: DeliveryNoteLine[];
  /** Situation financière de la commande d'origine. */
  totalAmount: number;
  paidAmount: number;
  restAmount: number;
}

/**
 * Bon de livraison — même mise en page que le BON DE COMMANDE (mêmes colonnes,
 * même bloc de totaux, même cartouche de signatures), seuls le titre et la
 * colonne des quantités livrées changent. Le prix unitaire ET le montant de la
 * quantité réellement livrée figurent sur chaque ligne, avec la valeur totale
 * de la livraison en pied de tableau.
 */
export function printDeliveryNote(data: DeliveryNoteData, store: StoreSettings) {
  const totalOrdered = data.lines.reduce((s, l) => s + l.ordered, 0);
  const totalNow = data.lines.reduce((s, l) => s + l.deliveredNow, 0);
  const totalAll = data.lines.reduce((s, l) => s + l.deliveredTotal, 0);
  const totalRemaining = data.lines.reduce((s, l) => s + Math.max(0, l.ordered - l.deliveredTotal), 0);
  /** Valeur marchande de ce qui est remis aujourd'hui. */
  const amountNow = data.lines.reduce((s, l) => s + l.deliveredNow * l.unitPrice, 0);
  /** Valeur marchande de tout ce qui a été remis depuis le début. */
  const amountAll = data.lines.reduce((s, l) => s + l.deliveredTotal * l.unitPrice, 0);
  const percent = totalOrdered > 0 ? Math.min(100, (totalAll / totalOrdered) * 100) : 0;
  const isFull = totalOrdered > 0 && totalRemaining <= 0.0001;
  const isPartial = totalAll > 0 && !isFull;

  const rows = data.lines
    .map((l, idx) => {
      const u = l.unit ? ` ${esc(l.unit)}` : '';
      const remaining = Math.max(0, l.ordered - l.deliveredTotal);
      return `<tr>
        <td class="center">${idx + 1}</td>
        <td><strong>${esc(l.productName)}</strong></td>
        <td class="center">${l.ordered}${u}</td>
        <td class="center" style="font-size:16px;font-weight:900;">${l.deliveredNow}${u}</td>
        <td class="center">${l.deliveredTotal}${u}</td>
        <td class="center" style="color:${remaining > 0 ? '#8f0f22' : '#0a5a38'};font-weight:900;">
          ${remaining > 0 ? `${remaining}${u}` : 'Complet'}
        </td>
        <td class="right">${formatCurrency(l.unitPrice)}</td>
        <td class="right"><strong>${formatCurrency(l.deliveredNow * l.unitPrice)}</strong></td>
      </tr>`;
    })
    .join('');

  const html = wrap(`
    ${header(store, data.historical ? 'ANCIENNE LIVRAISON' : 'BON DE LIVRAISON', [
      `<strong>N° ${esc(data.reference)}</strong>`,
      `Commande : ${esc(data.commandReference)}`,
      data.bonNumber ? `<strong>N° Bon : ${esc(data.bonNumber)}</strong>` : '',
      `Livré le : ${esc(formatDateTime(data.deliveredAt))}`,
    ].filter(Boolean))}
    <div class="content">
      ${doitBlock({
        name: data.clientName, phone: data.clientPhone, address: data.clientAddress,
        rc: data.clientRc, nif: data.clientNif, nis: data.clientNis, article: data.clientArticle,
      })}

      <div class="party" style="background:#fff;">
        <div class="lbl">Lieu de livraison (localisation)</div>
        <strong style="font-size:16px;">${esc(data.location || data.clientAddress || '—')}</strong>
        ${data.driverName || data.driverPlate
          ? `<br/>${data.driverName ? `<span class="lbl">Chauffeur :</span> <strong>${esc(data.driverName)}</strong>` : ''}${data.driverPlate ? `${data.driverName ? '&nbsp;&nbsp;·&nbsp;&nbsp;' : ''}<span class="lbl">Matricule :</span> <strong>${esc(data.driverPlate)}</strong>` : ''}`
          : ''}
      </div>

      <table>
        <thead>
          <tr>
            <th class="center" style="width:38px;">#</th>
            <th>Désignation</th>
            <th class="center">Qté commandée</th>
            <th class="center">Qté livrée ce jour</th>
            <th class="center">Qté livrée au total</th>
            <th class="center">Reste à livrer</th>
            <th class="right">P.U.</th>
            <th class="right">Montant livré</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <th colspan="2" class="right">TOTAUX</th>
            <th class="center">${totalOrdered}</th>
            <th class="center">${totalNow}</th>
            <th class="center">${totalAll}</th>
            <th class="center">${totalRemaining}</th>
            <th></th>
            <th class="right">${formatCurrency(amountNow)}</th>
          </tr>
        </tfoot>
      </table>

      ${data.notes ? `<div class="note"><strong>Observations :</strong> ${esc(data.notes)}</div>` : ''}

      <div style="margin-bottom:14px;">
        <span class="stamp ${isFull ? '' : 'warn'}">
          ${isFull ? 'COMMANDE ENTIÈREMENT LIVRÉE'
            : isPartial ? `LIVRAISON PARTIELLE — ${percent.toFixed(0)}%`
            : 'NON LIVRÉE'}
        </span>
        ${data.historical ? '<span class="stamp warn" style="margin-left:10px;">ANCIENNE LIVRAISON</span>' : ''}
      </div>

      <div class="totwrap">
        <div class="words">
          <div class="lbl">Valeur de la marchandise livrée</div>
          <div class="v">${esc(amountInWords(amountNow))}</div>
        </div>
        <div class="totals" style="margin:0;">
          <div class="grand"><span>Valeur livrée ce jour</span><strong>${formatCurrency(amountNow)}</strong></div>
          <div><span>Valeur livrée au total</span><strong>${formatCurrency(amountAll)}</strong></div>
          <div><span>Total Commande</span><strong>${formatCurrency(data.totalAmount)}</strong></div>
          <div class="ok"><span>Acompte versé</span><strong>${formatCurrency(data.paidAmount)}</strong></div>
          <div class="${data.restAmount > 0 ? 'due' : 'grand'}">
            <span>Reste à payer</span><strong>${formatCurrency(data.restAmount)}</strong>
          </div>
        </div>
      </div>

      <div class="note">
        Le client reconnaît avoir reçu les marchandises listées ci-dessus, dans les quantités
        indiquées et en bon état.
      </div>

      ${signBlock()}
      <div class="foot">${esc(store.socialMedia || '')} — Merci de votre confiance.</div>
    </div>`);

  printDocument(html, `Bon_de_Livraison_${data.reference}`);
}

/* ----------------------------------- rapport de livraisons sur une période */

export interface DeliveryPeriodLine {
  date: string;        // YYYY-MM-DD
  location?: string;
  designation: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  amount: number;
}

export interface DeliveryPeriodReportData {
  client: ClientFiscal;
  from: string;
  to: string;
  lines: DeliveryPeriodLine[];
  /** Applique la TVA au pied du tableau (HT / TVA / TTC). */
  applyTva?: boolean;
  tvaRate?: number;    // défaut 19
}

/**
 * Rapport de livraisons d'un client sur une période — modèle « Livraison du …
 * au … », lignes groupées par DATE puis LOCALISATION, avec TOTAL H.T, TVA et
 * TOTAL T.T.C. C'est le document manuscrit reproduit à l'identique.
 */
export function printDeliveryPeriodReport(data: DeliveryPeriodReportData, store: StoreSettings) {
  const ht = data.lines.reduce((s, l) => s + l.amount, 0);
  const rate = data.tvaRate ?? 19;
  const tva = data.applyTva ? Math.round(ht * rate) / 100 : 0;
  const ttc = ht + tva;

  let prevDate = '';
  let prevLoc = '';
  const rows = data.lines
    .map((l) => {
      const u = l.unit ? ` ${esc(l.unit)}` : '';
      const showDate = l.date !== prevDate;
      const showLoc = showDate || (l.location || '') !== prevLoc;
      prevDate = l.date;
      prevLoc = l.location || '';
      return `<tr>
        <td class="center">${showDate ? esc(formatDate(l.date)) : ''}</td>
        <td>${showLoc ? esc(l.location || '—') : ''}</td>
        <td><strong>${esc(l.designation)}</strong></td>
        <td class="center">${l.quantity}${u}</td>
        <td class="right">${formatCurrency(l.unitPrice)}</td>
        <td class="right"><strong>${formatCurrency(l.amount)}</strong></td>
      </tr>`;
    })
    .join('');

  const html = wrap(`
    ${header(store, 'BON DE LIVRAISON', [
      `<strong>Livraison du ${esc(formatDate(data.from))} au ${esc(formatDate(data.to))}</strong>`,
    ])}
    <div class="content">
      ${doitBlock(data.client)}

      <table>
        <thead>
          <tr>
            <th class="center">Date</th>
            <th>Localisation</th>
            <th>Désignation</th>
            <th class="center">Quantité</th>
            <th class="right">P.U</th>
            <th class="right">Montant</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6" class="center">Aucune livraison sur la période</td></tr>'}</tbody>
      </table>

      ${totalsTTC({ ht, tvaRate: rate, tvaAmount: tva, ttc })}

      ${signBlock()}
      <div class="foot">${esc(store.socialMedia || '')} — Merci de votre confiance.</div>
    </div>`);

  printDocument(html, `Livraisons_${data.client.name.replace(/\s+/g, '_')}`);
}

/* --------------------------------------------- bon de commande CLIENT */

export interface CommandOrderLine {
  productName: string;
  /** Quantité commandée par le client. */
  quantity: number;
  /** Quantité déjà livrée, toutes livraisons confondues. */
  deliveredQuantity?: number;
  unit?: string;
  unitPrice: number;
  totalPrice: number;
}

export interface CommandOrderData {
  reference: string;
  bonNumber?: string;
  createdAt: string;
  receiveDate: string;
  receiveHour: string;
  receiveMinute: string;
  clientName: string;
  clientPhone?: string;
  clientAddress?: string;
  /** Identifiants fiscaux du client (bloc DOIT). */
  clientRc?: string;
  clientNif?: string;
  clientNis?: string;
  clientArticle?: string;
  driverName?: string;
  driverPlate?: string;
  notes?: string;
  /** Ancienne commande saisie a posteriori. */
  historical?: boolean;
  lines: CommandOrderLine[];
  totalAmount: number;
  paidAmount: number;
  restAmount: number;
}

/**
 * Bon de commande client — imprimé depuis « Commandes clients » ET depuis la
 * caisse. Les quantités commandées / livrées / restantes de chaque production
 * y figurent explicitement.
 */
export function printCommandOrder(data: CommandOrderData, store: StoreSettings) {
  const ordered = data.lines.reduce((s, l) => s + l.quantity, 0);
  const delivered = data.lines.reduce((s, l) => s + (l.deliveredQuantity ?? 0), 0);
  const remainingAll = Math.max(0, ordered - delivered);
  const percent = ordered > 0 ? Math.min(100, (delivered / ordered) * 100) : 0;
  const isFull = ordered > 0 && remainingAll <= 0.0001;
  const isPartial = delivered > 0 && !isFull;

  const rows = data.lines
    .map((l, idx) => {
      const u = l.unit ? ` ${esc(l.unit)}` : '';
      const done = l.deliveredQuantity ?? 0;
      const left = Math.max(0, l.quantity - done);
      return `<tr>
        <td class="center">${idx + 1}</td>
        <td><strong>${esc(l.productName)}</strong></td>
        <td class="center" style="font-size:16px;font-weight:900;">${l.quantity}${u}</td>
        <td class="center">${done}${u}</td>
        <td class="center" style="color:${left > 0 ? '#8f0f22' : '#0a5a38'};font-weight:900;">
          ${left > 0 ? `${left}${u}` : 'Complet'}
        </td>
        <td class="right">${formatCurrency(l.unitPrice)}</td>
        <td class="right"><strong>${formatCurrency(l.totalPrice)}</strong></td>
      </tr>`;
    })
    .join('');

  const html = wrap(`
    ${header(store, data.historical ? 'ANCIENNE COMMANDE' : 'BON DE COMMANDE', [
      `<strong>Réf : ${esc(data.reference)}</strong>`,
      data.bonNumber ? `<strong>N° Bon : ${esc(data.bonNumber)}</strong>` : '',
      `Créée le : ${esc(formatDate(data.createdAt.slice(0, 10)))}`,
      `Livraison prévue : ${esc(formatDate(data.receiveDate))} à ${esc(data.receiveHour)}h${esc(data.receiveMinute)}`,
    ].filter(Boolean))}
    <div class="content">
      ${doitBlock({
        name: data.clientName, phone: data.clientPhone, address: data.clientAddress,
        rc: data.clientRc, nif: data.clientNif, nis: data.clientNis, article: data.clientArticle,
      })}

      ${data.driverName || data.driverPlate
        ? `<div class="party" style="background:#fff;">
             <div class="lbl">Transport</div>
             ${data.driverName ? `<span class="lbl">Chauffeur :</span> <strong style="font-size:16px;">${esc(data.driverName)}</strong>` : ''}
             ${data.driverPlate ? `${data.driverName ? '&nbsp;&nbsp;·&nbsp;&nbsp;' : ''}<span class="lbl">Matricule :</span> <strong style="font-size:16px;">${esc(data.driverPlate)}</strong>` : ''}
           </div>`
        : ''}

      <table>
        <thead>
          <tr>
            <th class="center" style="width:38px;">N°</th>
            <th>Désignation</th>
            <th class="center">Qté commandée</th>
            <th class="center">Qté livrée</th>
            <th class="center">Reste à livrer</th>
            <th class="right">P.U.</th>
            <th class="right">Montant</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <th colspan="2" class="right">TOTAUX</th>
            <th class="center">${ordered}</th>
            <th class="center">${delivered}</th>
            <th class="center">${remainingAll}</th>
            <th></th>
            <th class="right">${formatCurrency(data.totalAmount)}</th>
          </tr>
        </tfoot>
      </table>

      ${data.notes ? `<div class="note"><strong>Observations :</strong> ${esc(data.notes)}</div>` : ''}

      <div style="margin-bottom:14px;">
        <span class="stamp ${isFull ? '' : 'warn'}">
          ${isFull ? 'COMMANDE ENTIÈREMENT LIVRÉE'
            : isPartial ? `LIVRAISON PARTIELLE — ${percent.toFixed(0)}%`
            : 'NON LIVRÉE'}
        </span>
        ${data.historical ? '<span class="stamp warn" style="margin-left:10px;">ANCIENNE COMMANDE</span>' : ''}
      </div>

      ${totalsTTC({
        ht: data.totalAmount, ttc: data.totalAmount,
        paid: data.paidAmount, rest: data.restAmount, showPaid: true,
      })}

      ${signBlock()}
      <div class="foot">${esc(store.socialMedia || '')} — Merci de votre confiance.</div>
    </div>`);

  printDocument(html, `Bon_de_Commande_${data.reference}`);
}

/* ---------------------------------------------------------- bon de commande */

export interface PurchaseOrderData {
  reference: string;
  date: string;
  supplierName?: string;
  notes?: string;
  items: { productName: string; description: string; quantity: number; unit?: string }[];
}

export function printPurchaseOrder(data: PurchaseOrderData, store: StoreSettings) {
  const rows = data.items
    .map(
      (i, idx) => `<tr>
        <td class="center">${idx + 1}</td>
        <td><strong>${esc(i.productName)}</strong></td>
        <td>${esc(i.description || '—')}</td>
        <td class="center"><strong>${i.quantity}${i.unit ? ` ${esc(i.unit)}` : ''}</strong></td>
      </tr>`
    )
    .join('');

  const html = wrap(`
    ${header(store, 'BON DE COMMANDE', [
      `<strong>N° ${esc(data.reference)}</strong>`,
      `Date : ${esc(formatDate(data.date))}`,
    ])}
    <div class="content">
      ${data.supplierName
        ? `<div class="party"><div class="lbl">Fournisseur</div><strong style="font-size:15px;">${esc(data.supplierName)}</strong></div>`
        : ''}

      <table>
        <thead>
          <tr><th class="center" style="width:40px;">#</th><th>Produit</th><th>Description</th><th class="center">Quantité</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      ${data.notes ? `<div class="note"><strong>Observations :</strong> ${esc(data.notes)}</div>` : ''}

      <div class="signs">
        <div class="sign">Signature Demandeur</div>
        <div class="sign">Cachet &amp; Signature Entreprise</div>
      </div>
      <div class="foot">Document interne — bon de commande fournisseur.</div>
    </div>`);

  printDocument(html, `Bon_Commande_${data.reference}`);
}

/* --------------------------------------------------------- fiche production */

export interface ProductionSheetData {
  name: string;
  date: string;
  hour: string;
  categoryName?: string;
  description?: string;
  createdBy?: string;
  outputQuantity: number;
  sellUnit?: string;
  unitPrice: number;
  totalValue: number;
  totalCost: number;
  sentToComptoir: number;
  hasLoss?: boolean;
  expectedQuantity?: number;
  lossQuantity?: number;
  lossValue?: number;
  lossDescription?: string;
  ingredients: { productName: string; quantityUsed: number; unit?: string; unitCost: number; lineCost: number }[];
}

export function printProductionSheet(data: ProductionSheetData, store: StoreSettings) {
  const u = data.sellUnit ? ` ${esc(data.sellUnit)}` : '';
  const rows = data.ingredients
    .map(
      (i) => `<tr>
        <td><strong>${esc(i.productName)}</strong></td>
        <td class="center">${i.quantityUsed}${i.unit ? ` ${esc(i.unit)}` : ''}</td>
        <td class="right">${formatCurrency(i.unitCost)}</td>
        <td class="right">${formatCurrency(i.lineCost)}</td>
      </tr>`
    )
    .join('');

  const gains = data.totalValue - data.totalCost;

  const html = wrap(`
    ${header(store, 'FICHE DE PRODUCTION', [
      `<strong>${esc(data.name)}</strong>`,
      `Date : ${esc(formatDate(data.date))} à ${esc(data.hour)}`,
      data.categoryName ? `Catégorie : ${esc(data.categoryName)}` : '',
    ].filter(Boolean))}
    <div class="content">
      ${data.description ? `<div class="note"><em>${esc(data.description)}</em></div>` : ''}

      <h3 style="font-size:13px;margin-bottom:8px;">Matières premières consommées</h3>
      <table>
        <thead>
          <tr><th>Ingrédient</th><th class="center">Quantité</th><th class="right">Coût unitaire</th><th class="right">Coût ligne</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><th colspan="3" class="right">Coût total des matières</th><th class="right">${formatCurrency(data.totalCost)}</th></tr>
        </tfoot>
      </table>

      <h3 style="font-size:13px;margin-bottom:8px;">Résultat de la production</h3>
      <table>
        <tbody>
          <tr><td>Quantité produite</td><td class="right"><strong>${data.outputQuantity}${u}</strong></td></tr>
          <tr><td>Envoyée au comptoir</td><td class="right">${data.sentToComptoir}${u}</td></tr>
          <tr><td>Reste en stock production</td><td class="right">${data.outputQuantity - data.sentToComptoir}${u}</td></tr>
          <tr><td>Prix de vente unitaire</td><td class="right">${formatCurrency(data.unitPrice)}${data.sellUnit ? ` / ${esc(data.sellUnit)}` : ''}</td></tr>
          ${data.hasLoss
            ? `<tr><td>Quantité prévue</td><td class="right">${data.expectedQuantity ?? 0}${u}</td></tr>
               <tr><td style="color:#b91c1c;">Perte constatée</td><td class="right" style="color:#b91c1c;font-weight:bold;">
                 ${data.lossQuantity ?? 0}${u} (${formatCurrency(data.lossValue ?? 0)})</td></tr>
               ${data.lossDescription ? `<tr><td>Motif de la perte</td><td class="right">${esc(data.lossDescription)}</td></tr>` : ''}`
            : ''}
        </tbody>
      </table>

      <div class="totals">
        <div><span>Coût de production</span><strong>${formatCurrency(data.totalCost)}</strong></div>
        <div><span>Valeur de vente estimée</span><strong>${formatCurrency(data.totalValue)}</strong></div>
        <div class="${gains >= 0 ? 'ok' : 'due'}"><span>Gain net estimé</span><strong>${formatCurrency(gains)}</strong></div>
      </div>

      <div class="signs">
        <div class="sign">Responsable production</div>
        <div class="sign">Cachet &amp; Signature Entreprise</div>
      </div>
      <div class="foot">${data.createdBy ? `Enregistré par ${esc(data.createdBy)}` : ''}</div>
    </div>`);

  printDocument(html, `Production_${data.name.replace(/\s+/g, '_')}`);
}

/* ------------------------------------------------ reçu heures supplémentaires */

export interface OvertimeReceiptData {
  workerName: string;
  role?: string;
  paidAt: string;
  amount: number;
  lines: { date: string; from: string; to: string; hours: number; rate: number; amount: number; description?: string }[];
}

export function printOvertimeReceipt(data: OvertimeReceiptData, store: StoreSettings) {
  const rows = data.lines
    .map(
      (l) => `<tr>
        <td class="center">${esc(formatDate(l.date))}</td>
        <td class="center">${esc(l.from)} → ${esc(l.to)}</td>
        <td class="center">${l.hours.toFixed(2)} h</td>
        <td class="right">${formatCurrency(l.rate)}</td>
        <td class="right"><strong>${formatCurrency(l.amount)}</strong></td>
      </tr>`
    )
    .join('');
  const totalHours = data.lines.reduce((s, l) => s + l.hours, 0);

  const html = wrap(`
    ${header(store, 'REÇU HEURES SUPPLÉMENTAIRES', [
      `<strong>${esc(data.workerName)}</strong>`,
      data.role ? `Poste : ${esc(data.role)}` : '',
      `Payé le : ${esc(formatDateTime(data.paidAt))}`,
    ].filter(Boolean))}
    <div class="content">
      <table>
        <thead>
          <tr><th class="center">Date</th><th class="center">Horaire</th><th class="center">Durée</th><th class="right">Taux horaire</th><th class="right">Montant</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><th colspan="2" class="right">Total</th><th class="center">${totalHours.toFixed(2)} h</th><th></th><th class="right">${formatCurrency(data.amount)}</th></tr>
        </tfoot>
      </table>

      <div class="totals">
        <div class="grand"><span>Montant versé</span><strong>${formatCurrency(data.amount)}</strong></div>
      </div>

      <div class="signs">
        <div class="sign">Signature Employé</div>
        <div class="sign">Cachet &amp; Signature Entreprise</div>
      </div>
    </div>`);

  printDocument(html, `Heures_Sup_${data.workerName.replace(/\s+/g, '_')}`);
}
