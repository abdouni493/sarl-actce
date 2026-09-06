import type { StoreSettings, PaymentMethod } from '@/types';
import { formatCurrency, formatDate, formatDateTime, paymentMethodLabel } from './utils';
import { amountInWords } from './invoicePrint';
import {
  printOfficialDocument, versementLine,
  type DocRow, type DocTotal,
} from './officialDoc';

/* ============================================================================
 *  DOCUMENTS IMPRIMABLES DE L'ENTREPRISE
 * ----------------------------------------------------------------------------
 *  Bon de livraison, bon de commande, reçu de versement, bon de commande
 *  fournisseur, fiche de production et reçu d'heures supplémentaires.
 *
 *  Tous partagent EXACTEMENT le même papier à en-tête (`printOfficialDocument`,
 *  cf. `officialDoc.ts`) : raison sociale soulignée, activité, lieu d'activité,
 *  siège social et téléphone, mention « <VILLE> LE jj/mm/aaaa », titre du
 *  document souligné, bloc « DOIT », tableau encadré, totaux collés au pied du
 *  tableau, versements en bas à gauche et signature en bas à droite.
 *
 *  Seules changent les colonnes et le bloc de totaux, selon le contenu propre à
 *  chaque document.
 * ========================================================================== */

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

/** Lignes d'identification reprises sous le nom du destinataire. */
function fiscalLines(c: ClientFiscal): string[] {
  return [
    c.address ? `ADRESSE : ${c.address}` : '',
    c.rc ? `R.C N° : ${c.rc}` : '',
    c.nif ? `NIF : ${c.nif}` : '',
    c.nis ? `NIS : ${c.nis}` : '',
    c.article ? `N° ARTICLE : ${c.article}` : '',
    c.phone ? `TEL : ${c.phone}` : '',
  ].filter(Boolean);
}

/** Colonne « DOSAGE » du modèle : l'unité de vente, ou « / » quand il n'y en a pas. */
const dosage = (unit?: string) => (unit && unit.trim() ? unit : '/');

/** Nombre affiché sans décimale inutile (74,5 / 31 / 1). */
function qty(n: number): string {
  const v = Math.round((n || 0) * 1000) / 1000;
  return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
}

/**
 * Bloc de totaux commun : TOTAL H.T → TVA → TOTAL T.T.C → VERSEMENT → LE REST.
 * La TVA n'apparaît QUE si elle est activée sur le document.
 */
function totalsBlock(o: {
  ht: number;
  tvaEnabled?: boolean;
  tvaRate?: number;
  tvaAmount?: number;
  ttc: number;
  paid?: number;
  rest?: number;
  showPayment?: boolean;
  htLabel?: string;
}): DocTotal[] {
  const rows: DocTotal[] = [{ label: o.htLabel || 'Total H.T', value: formatCurrency(o.ht) }];
  if (o.tvaEnabled) {
    rows.push({ label: `T.V.A ${o.tvaRate ?? 19} %`, value: formatCurrency(o.tvaAmount ?? 0) });
    rows.push({ label: 'Total T.T.C', value: formatCurrency(o.ttc), strong: true });
  } else {
    rows.push({ label: 'Total', value: formatCurrency(o.ttc), strong: true });
  }
  if (o.showPayment) {
    rows.push({ label: 'Versement', value: formatCurrency(o.paid ?? 0) });
    rows.push({ label: 'Le rest', value: formatCurrency(o.rest ?? 0), strong: true });
  }
  return rows;
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
  const methodLabel = paymentMethodLabel(data);
  const detail = [
    data.method === 'cheque' && data.chequeNumber ? `N° DE CHEQUE : ${data.chequeNumber}` : '',
    data.method === 'virement' && data.virementNumber ? `N° DE VIREMENT : ${data.virementNumber}` : '',
    data.method !== 'especes' && data.bankName ? `BANQUE : ${data.bankName}` : '',
  ].filter(Boolean);

  printOfficialDocument(
    {
      title: isClient ? 'REÇU DE VERSEMENT CLIENT' : 'REÇU DE RÈGLEMENT FOURNISSEUR',
      docDate: data.paidAt,
      doitLabel: isClient ? 'REÇU DE' : 'VERSÉ À',
      doitName: data.partyName,
      doitLines: [data.partyPhone ? `TEL : ${data.partyPhone}` : ''].filter(Boolean),
      metaLines: [`N° ${data.receiptNumber}`, `LE ${formatDateTime(data.paidAt)}`],
      tables: [
        {
          columns: [
            { label: 'Date', align: 'center', width: '16%' },
            { label: 'Désignation', align: 'left' },
            { label: 'Mode de règlement', align: 'center', width: '22%' },
            { label: 'Montant', align: 'right', width: '20%' },
          ],
          rows: [
            {
              cells: [
                formatDate(data.paidAt),
                isClient
                  ? `Versement du client ${data.partyName}`
                  : `Règlement au fournisseur ${data.partyName}`,
                methodLabel,
                formatCurrency(data.amount),
              ],
            },
            ...detail.map<DocRow>((d) => ({ cells: ['', d, '', ''] })),
          ],
          totals: [
            { label: 'Dette totale', value: formatCurrency(data.totalDebt) },
            {
              label: isClient ? 'Versement de ce jour' : 'Réglé ce jour',
              value: formatCurrency(data.amount),
            },
            { label: 'Total payé', value: formatCurrency(data.totalPaid) },
            { label: 'Le rest', value: formatCurrency(data.restAmount), strong: true },
          ],
        },
      ],
      amountInWords: amountInWords(data.amount),
      observations: data.notes,
      stamps: [
        data.restAmount > 0
          ? { label: 'Versement partiel', tone: 'warn' as const }
          : { label: 'Dette soldée', tone: 'ok' as const },
      ],
      signatures: [isClient ? 'Le client' : 'Le fournisseur', 'Signature'],
      fileName: `Recu_${data.receiptNumber}`,
    },
    store
  );
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
  /** TVA propre à CE bon — masquée sur le document quand elle est désactivée. */
  tvaEnabled?: boolean;
  tvaRate?: number;
  tvaAmount?: number;
  /** Situation financière de CETTE livraison (elle vaut vente). */
  deliveryTotalHt?: number;
  deliveryTotalTtc?: number;
  deliveryPaid?: number;
  deliveryRest?: number;
  /** Facture de vente engendrée par ce bon. */
  saleReference?: string;
  /** Acompte de la commande imputé sur ce bon. */
  advanceApplied?: number;
  /** Encaissement réalisé au moment de la remise. */
  cashPaid?: number;
  /** Situation financière de la commande d'origine. */
  totalAmount: number;
  paidAmount: number;
  restAmount: number;
}

/**
 * BON DE LIVRAISON — modèle officiel de l'entreprise.
 * La livraison vaut VENTE : le bon porte donc la valeur de la marchandise
 * remise, la TVA quand elle est activée, le versement du client et le reste dû.
 */
export function printDeliveryNote(data: DeliveryNoteData, store: StoreSettings) {
  const totalOrdered = data.lines.reduce((s, l) => s + l.ordered, 0);
  const totalNow = data.lines.reduce((s, l) => s + l.deliveredNow, 0);
  const totalAll = data.lines.reduce((s, l) => s + l.deliveredTotal, 0);
  const totalRemaining = data.lines.reduce((s, l) => s + Math.max(0, l.ordered - l.deliveredTotal), 0);
  const ht = data.deliveryTotalHt ?? data.lines.reduce((s, l) => s + l.deliveredNow * l.unitPrice, 0);
  const tvaAmount = data.tvaEnabled
    ? data.tvaAmount ?? Math.round(ht * (data.tvaRate ?? 19)) / 100
    : 0;
  const ttc = data.deliveryTotalTtc ?? ht + tvaAmount;
  const paid = data.deliveryPaid ?? 0;
  const rest = data.deliveryRest ?? Math.max(0, ttc - paid);
  const isFull = totalOrdered > 0 && totalRemaining <= 0.0001;
  const percent = totalOrdered > 0 ? Math.min(100, (totalAll / totalOrdered) * 100) : 0;

  const rows: DocRow[] = data.lines.map((l) => {
    const left = Math.max(0, l.ordered - l.deliveredTotal);
    return {
      cells: [
        formatDate(data.deliveredAt),
        l.productName.toUpperCase(),
        dosage(l.unit),
        qty(l.ordered),
        qty(l.deliveredNow),
        left > 0 ? qty(left) : 'COMPLET',
        formatCurrency(l.unitPrice),
        formatCurrency(l.deliveredNow * l.unitPrice),
      ],
    };
  });

  const versements: string[] = [];
  if (data.advanceApplied && data.advanceApplied > 0) {
    versements.push(
      `ACOMPTE COMMANDE ${data.commandReference} IMPUTÉ : ${formatCurrency(data.advanceApplied)}`
    );
  }
  if (data.cashPaid && data.cashPaid > 0) {
    versements.push(versementLine(data.cashPaid, data.deliveredAt));
  }
  if (!versements.length && paid > 0) versements.push(versementLine(paid, data.deliveredAt));
  if (rest > 0) versements.push(`LE REST : ${formatCurrency(rest)}`);

  printOfficialDocument(
    {
      title: data.historical ? 'ANCIENNE LIVRAISON' : 'BON DE LIVRAISON',
      docDate: data.deliveredAt,
      doitName: data.clientName,
      doitLines: fiscalLines({
        name: data.clientName, phone: data.clientPhone, address: data.clientAddress,
        rc: data.clientRc, nif: data.clientNif, nis: data.clientNis, article: data.clientArticle,
      }),
      metaLines: [
        `N° ${data.reference}`,
        `COMMANDE : ${data.commandReference}`,
        data.bonNumber ? `N° BON : ${data.bonNumber}` : '',
        data.saleReference ? `FACTURE : ${data.saleReference}` : '',
        `LIVRÉ LE : ${formatDateTime(data.deliveredAt)}`,
        `LIEU : ${(data.location || data.clientAddress || '—').toUpperCase()}`,
        data.driverName ? `CHAUFFEUR : ${data.driverName}` : '',
        data.driverPlate ? `MATRICULE : ${data.driverPlate}` : '',
      ].filter(Boolean),
      tables: [
        {
          columns: [
            { label: 'Date', align: 'center', width: '10%' },
            { label: 'Désignation', align: 'left' },
            { label: 'Dosage', align: 'center', width: '8%' },
            { label: 'Qté commandée', align: 'center', width: '10%' },
            { label: 'Quantité', align: 'center', width: '10%' },
            { label: 'Reste à livrer', align: 'center', width: '10%' },
            { label: 'Prix unitaire', align: 'right', width: '13%' },
            { label: 'Total', align: 'right', width: '15%' },
          ],
          rows,
          totals: totalsBlock({
            ht, tvaEnabled: data.tvaEnabled, tvaRate: data.tvaRate, tvaAmount,
            ttc, paid, rest, showPayment: true,
          }),
          emptyLabel: 'Aucune quantité livrée sur ce bon',
        },
        {
          title: 'Situation de la commande',
          columns: [
            { label: 'Désignation', align: 'left' },
            { label: 'Montant', align: 'right', width: '28%' },
          ],
          rows: [
            { cells: ['Total de la commande', formatCurrency(data.totalAmount)] },
            { cells: ['Total versé sur la commande', formatCurrency(data.paidAmount)] },
            { cells: ['Reste dû sur la commande', formatCurrency(data.restAmount)], variant: 'subtotal' },
            { cells: ['Quantité commandée', qty(totalOrdered)] },
            { cells: ['Quantité livrée à ce jour', qty(totalAll)] },
            { cells: ['Reste à livrer', qty(totalRemaining)], variant: 'subtotal' },
          ],
        },
      ],
      amountInWords: amountInWords(ttc),
      observations: data.notes,
      stamps: [
        isFull
          ? { label: 'Commande entièrement livrée', tone: 'ok' as const }
          : { label: `Livraison partielle — ${percent.toFixed(0)} %`, tone: 'warn' as const },
        ...(data.historical ? [{ label: 'Ancienne livraison', tone: 'warn' as const }] : []),
        rest > 0
          ? { label: 'Livraison à crédit', tone: 'warn' as const }
          : { label: 'Livraison réglée', tone: 'ok' as const },
      ],
      footNotes: [
        ...versements,
        'LE CLIENT RECONNAÎT AVOIR REÇU LES MARCHANDISES CI-DESSUS EN BON ÉTAT.',
      ],
      signatures: ['Le client', 'Signature'],
      fileName: `Bon_de_Livraison_${data.reference}`,
    },
    store
  );
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
  /** Versements du client sur la période — repris en bas à gauche. */
  versements?: { amount: number; date: string }[];
  /** Total déjà versé et reste dû sur la période. */
  paidAmount?: number;
  restAmount?: number;
}

/**
 * BON DE LIVRAISON SUR UNE PÉRIODE — c'est le document manuscrit reproduit à
 * l'identique : une ligne par remise (DATE · DESIGNATION · DOSAGE · QUANTITE ·
 * PRIX UNITAIRE · TOTAL), TOTAL HT / VERSEMENT / LE REST au pied du tableau et
 * le détail des versements en bas à gauche.
 */
export function printDeliveryPeriodReport(data: DeliveryPeriodReportData, store: StoreSettings) {
  const ht = data.lines.reduce((s, l) => s + l.amount, 0);
  const rate = data.tvaRate ?? 19;
  const tva = data.applyTva ? Math.round(ht * rate) / 100 : 0;
  const ttc = ht + tva;
  const paid = data.paidAmount ?? 0;
  const rest = data.restAmount ?? Math.max(0, ttc - paid);

  let prevDate = '';
  const rows: DocRow[] = data.lines.map((l) => {
    const showDate = l.date !== prevDate;
    prevDate = l.date;
    return {
      cells: [
        showDate ? formatDate(l.date) : '',
        l.designation.toUpperCase(),
        dosage(l.unit),
        qty(l.quantity),
        formatCurrency(l.unitPrice),
        formatCurrency(l.amount),
      ],
    };
  });

  printOfficialDocument(
    {
      title: 'BON DE LIVRAISON',
      docDate: data.to,
      doitName: data.client.name,
      doitLines: fiscalLines(data.client),
      metaLines: [`LIVRAISON DU ${formatDate(data.from)} AU ${formatDate(data.to)}`],
      tables: [
        {
          columns: [
            { label: 'Date', align: 'center', width: '13%' },
            { label: 'Désignation', align: 'left' },
            { label: 'Dosage', align: 'center', width: '10%' },
            { label: 'Quantité', align: 'center', width: '12%' },
            { label: 'Prix unitaire', align: 'right', width: '16%' },
            { label: 'Total', align: 'right', width: '18%' },
          ],
          rows,
          totals: totalsBlock({
            ht, tvaEnabled: data.applyTva, tvaRate: rate, tvaAmount: tva, ttc,
            paid, rest, showPayment: (data.versements?.length ?? 0) > 0 || paid > 0 || rest > 0,
          }),
          emptyLabel: 'Aucune livraison sur la période',
        },
      ],
      amountInWords: amountInWords(ttc),
      footNotes: (data.versements ?? []).map((v) => versementLine(v.amount, v.date)),
      signatures: ['Signature'],
      fileName: `Livraisons_${data.client.name.replace(/\s+/g, '_')}`,
    },
    store
  );
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
  /** TVA de la commande — masquée sur le document quand elle est désactivée. */
  tvaEnabled?: boolean;
  tvaRate?: number;
  tvaAmount?: number;
  /** Total HORS TAXES de la commande. */
  totalAmount: number;
  /** Net à payer TTC. Vaut le total HT quand la TVA est désactivée. */
  totalTtc?: number;
  paidAmount: number;
  restAmount: number;
  /** Versements déjà encaissés sur la commande — repris en bas à gauche. */
  versements?: { amount: number; date: string; label?: string }[];
}

/**
 * BON DE COMMANDE CLIENT — même papier que le bon de livraison, colonnes
 * adaptées au contenu : ce qui est commandé, ce qui est déjà livré et ce qui
 * reste à livrer, puis TOTAL H.T / TVA / TOTAL T.T.C / VERSEMENT / LE REST.
 */
export function printCommandOrder(data: CommandOrderData, store: StoreSettings) {
  const ordered = data.lines.reduce((s, l) => s + l.quantity, 0);
  const delivered = data.lines.reduce((s, l) => s + (l.deliveredQuantity ?? 0), 0);
  const remainingAll = Math.max(0, ordered - delivered);
  const percent = ordered > 0 ? Math.min(100, (delivered / ordered) * 100) : 0;
  const isFull = ordered > 0 && remainingAll <= 0.0001;
  const tvaAmount = data.tvaEnabled
    ? data.tvaAmount ?? Math.round(data.totalAmount * (data.tvaRate ?? 19)) / 100
    : 0;
  const ttc = data.totalTtc ?? data.totalAmount + tvaAmount;

  const rows: DocRow[] = data.lines.map((l) => {
    const done = l.deliveredQuantity ?? 0;
    const left = Math.max(0, l.quantity - done);
    return {
      cells: [
        l.productName.toUpperCase(),
        dosage(l.unit),
        qty(l.quantity),
        qty(done),
        left > 0 ? qty(left) : 'COMPLET',
        formatCurrency(l.unitPrice),
        formatCurrency(l.totalPrice),
      ],
    };
  });

  printOfficialDocument(
    {
      title: data.historical ? 'ANCIENNE COMMANDE' : 'BON DE COMMANDE',
      docDate: data.createdAt,
      doitName: data.clientName,
      doitLines: fiscalLines({
        name: data.clientName, phone: data.clientPhone, address: data.clientAddress,
        rc: data.clientRc, nif: data.clientNif, nis: data.clientNis, article: data.clientArticle,
      }),
      metaLines: [
        `RÉF : ${data.reference}`,
        data.bonNumber ? `N° BON : ${data.bonNumber}` : '',
        `CRÉÉE LE : ${formatDate(data.createdAt.slice(0, 10))}`,
        `LIVRAISON PRÉVUE : ${formatDate(data.receiveDate)} À ${data.receiveHour}H${data.receiveMinute}`,
        data.driverName ? `CHAUFFEUR : ${data.driverName}` : '',
        data.driverPlate ? `MATRICULE : ${data.driverPlate}` : '',
      ].filter(Boolean),
      tables: [
        {
          columns: [
            { label: 'Désignation', align: 'left' },
            { label: 'Dosage', align: 'center', width: '9%' },
            { label: 'Quantité', align: 'center', width: '11%' },
            { label: 'Qté livrée', align: 'center', width: '11%' },
            { label: 'Reste à livrer', align: 'center', width: '11%' },
            { label: 'Prix unitaire', align: 'right', width: '15%' },
            { label: 'Total', align: 'right', width: '17%' },
          ],
          rows,
          totals: totalsBlock({
            ht: data.totalAmount, tvaEnabled: data.tvaEnabled, tvaRate: data.tvaRate,
            tvaAmount, ttc, paid: data.paidAmount, rest: data.restAmount, showPayment: true,
          }),
          emptyLabel: 'Aucun produit sur cette commande',
        },
      ],
      amountInWords: amountInWords(ttc),
      observations: data.notes,
      stamps: [
        isFull
          ? { label: 'Commande entièrement livrée', tone: 'ok' as const }
          : delivered > 0
            ? { label: `Livraison partielle — ${percent.toFixed(0)} %`, tone: 'warn' as const }
            : { label: 'Non livrée', tone: 'warn' as const },
        ...(data.historical ? [{ label: 'Ancienne commande', tone: 'warn' as const }] : []),
      ],
      footNotes: (data.versements ?? []).map((v) =>
        v.label ? `${v.label.toUpperCase()} : ${formatCurrency(v.amount)}` : versementLine(v.amount, v.date)
      ),
      signatures: ['Le client', 'Signature'],
      fileName: `Bon_de_Commande_${data.reference}`,
    },
    store
  );
}

/* ------------------------------------------- bon de commande FOURNISSEUR */

export interface PurchaseOrderData {
  reference: string;
  date: string;
  supplierName?: string;
  notes?: string;
  items: { productName: string; description: string; quantity: number; unit?: string }[];
}

export function printPurchaseOrder(data: PurchaseOrderData, store: StoreSettings) {
  printOfficialDocument(
    {
      title: 'BON DE COMMANDE FOURNISSEUR',
      docDate: data.date,
      doitLabel: 'FOURNISSEUR',
      doitName: data.supplierName || '—',
      metaLines: [`N° ${data.reference}`, `DATE : ${formatDate(data.date)}`],
      tables: [
        {
          columns: [
            { label: 'N°', align: 'center', width: '7%' },
            { label: 'Désignation', align: 'left' },
            { label: 'Description', align: 'left' },
            { label: 'Quantité', align: 'center', width: '16%' },
          ],
          rows: data.items.map((i, idx) => ({
            cells: [
              String(idx + 1),
              i.productName.toUpperCase(),
              i.description || '—',
              `${qty(i.quantity)} ${dosage(i.unit) === '/' ? '' : i.unit}`.trim(),
            ],
          })),
          emptyLabel: 'Aucun produit demandé',
        },
      ],
      observations: data.notes,
      signatures: ['Le demandeur', 'Signature'],
      fileName: `Bon_Commande_${data.reference}`,
    },
    store
  );
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
  const u = data.sellUnit ? ` ${data.sellUnit}` : '';
  const gains = data.totalValue - data.totalCost;

  printOfficialDocument(
    {
      title: 'FICHE DE PRODUCTION',
      docDate: data.date,
      doitLabel: 'PRODUCTION',
      doitName: data.name,
      doitLines: [
        data.categoryName ? `CATÉGORIE : ${data.categoryName}` : '',
        `LE ${formatDate(data.date)} À ${data.hour}`,
      ].filter(Boolean),
      metaLines: [
        `QUANTITÉ PRODUITE : ${qty(data.outputQuantity)}${u}`,
        data.createdBy ? `PAR : ${data.createdBy}` : '',
      ].filter(Boolean),
      tables: [
        {
          title: 'Matières premières consommées',
          columns: [
            { label: 'Désignation', align: 'left' },
            { label: 'Dosage', align: 'center', width: '10%' },
            { label: 'Quantité', align: 'center', width: '13%' },
            { label: 'Coût unitaire', align: 'right', width: '17%' },
            { label: 'Total', align: 'right', width: '18%' },
          ],
          rows: data.ingredients.map((i) => ({
            cells: [
              i.productName.toUpperCase(), dosage(i.unit), qty(i.quantityUsed),
              formatCurrency(i.unitCost), formatCurrency(i.lineCost),
            ],
          })),
          totals: [{ label: 'Coût total des matières', value: formatCurrency(data.totalCost), strong: true }],
          emptyLabel: 'Aucune matière consommée',
        },
        {
          title: 'Résultat de la production',
          columns: [
            { label: 'Désignation', align: 'left' },
            { label: 'Valeur', align: 'right', width: '30%' },
          ],
          rows: [
            { cells: ['Quantité produite', `${qty(data.outputQuantity)}${u}`] },
            { cells: ['Envoyée au comptoir', `${qty(data.sentToComptoir)}${u}`] },
            { cells: ['Reste en stock production', `${qty(data.outputQuantity - data.sentToComptoir)}${u}`] },
            { cells: ['Prix de vente unitaire', formatCurrency(data.unitPrice)] },
            ...(data.hasLoss
              ? [
                  { cells: ['Quantité prévue', `${qty(data.expectedQuantity ?? 0)}${u}`] },
                  {
                    cells: [
                      `Perte constatée${data.lossDescription ? ` — ${data.lossDescription}` : ''}`,
                      `${qty(data.lossQuantity ?? 0)}${u} (${formatCurrency(data.lossValue ?? 0)})`,
                    ],
                    variant: 'subtotal' as const,
                  },
                ]
              : []),
          ],
          totals: [
            { label: 'Coût de production', value: formatCurrency(data.totalCost) },
            { label: 'Valeur de vente estimée', value: formatCurrency(data.totalValue) },
            { label: 'Gain net estimé', value: formatCurrency(gains), strong: true },
          ],
        },
      ],
      observations: data.description,
      signatures: ['Responsable production', 'Signature'],
      fileName: `Production_${data.name.replace(/\s+/g, '_')}`,
    },
    store
  );
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
  const totalHours = data.lines.reduce((s, l) => s + l.hours, 0);

  printOfficialDocument(
    {
      title: 'REÇU HEURES SUPPLÉMENTAIRES',
      docDate: data.paidAt,
      doitLabel: 'EMPLOYÉ',
      doitName: data.workerName,
      doitLines: [data.role ? `POSTE : ${data.role}` : ''].filter(Boolean),
      metaLines: [`PAYÉ LE : ${formatDateTime(data.paidAt)}`],
      tables: [
        {
          columns: [
            { label: 'Date', align: 'center', width: '14%' },
            { label: 'Horaire', align: 'center', width: '18%' },
            { label: 'Désignation', align: 'left' },
            { label: 'Durée', align: 'center', width: '11%' },
            { label: 'Taux horaire', align: 'right', width: '16%' },
            { label: 'Total', align: 'right', width: '17%' },
          ],
          rows: data.lines.map((l) => ({
            cells: [
              formatDate(l.date), `${l.from} → ${l.to}`,
              (l.description || 'Heures supplémentaires').toUpperCase(),
              `${l.hours.toFixed(2)} H`, formatCurrency(l.rate), formatCurrency(l.amount),
            ],
          })),
          totals: [
            { label: `Total heures : ${totalHours.toFixed(2)} h`, value: formatCurrency(data.amount), strong: true },
          ],
          emptyLabel: 'Aucune heure supplémentaire',
        },
      ],
      amountInWords: amountInWords(data.amount),
      footNotes: [versementLine(data.amount, data.paidAt)],
      signatures: ["L'employé", 'Signature'],
      fileName: `Heures_Sup_${data.workerName.replace(/\s+/g, '_')}`,
    },
    store
  );
}
