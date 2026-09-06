import type { StoreSettings } from '@/types';
import { formatCurrency, formatDate, formatDateTime } from './utils';
import { amountInWords } from './invoicePrint';
import { printOfficialDocument, versementLine, type DocRow, type DocTotal } from './officialDoc';

/* ============================================================================
 *  FACTURES D'ACHAT / DE VENTE — papier à en-tête officiel
 * ----------------------------------------------------------------------------
 *  Même modèle que le bon de livraison de l'entreprise (`officialDoc.ts`).
 *  Utilisé par « Achats » et par l'historique d'un fournisseur.
 * ========================================================================== */

interface InvoiceLine {
  designation: string;
  quantity: number;
  unitPrice: number;
  /** Dosage / unité affichée dans la colonne du milieu. */
  unit?: string;
}

interface InvoiceData {
  type: 'purchase' | 'sale';
  reference: string;
  date: string;
  partyName: string;
  partyPhone?: string;
  partyAddress?: string;
  /** N° du bon de livraison fournisseur (achats) */
  bonNumber?: string;
  /** Immatriculation du camion qui a livré (achats) */
  driverPlate?: string;
  /** Facture antérieure saisie a posteriori — le stock n'a pas été mouvementé. */
  historical?: boolean;
  /** TVA de la facture — imprimée uniquement quand elle est activée. */
  tvaEnabled?: boolean;
  tvaRate?: number;
  tvaAmount?: number;
  lines: InvoiceLine[];
  total: number;
  reduction?: number;
  final?: number;
  paid: number;
  rest: number;
}

/** Quantité affichée sans décimale inutile. */
function qty(n: number): string {
  const v = Math.round((n || 0) * 1000) / 1000;
  return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
}

export function printInvoice(data: InvoiceData, store: StoreSettings) {
  const isPurchase = data.type === 'purchase';
  const base = Math.max(0, data.total - (data.reduction || 0));
  const tvaAmount = data.tvaEnabled
    ? data.tvaAmount ?? Math.round(base * (data.tvaRate ?? 19)) / 100
    : 0;
  const net = data.final ?? base + tvaAmount;

  const totals: DocTotal[] = [{ label: 'Total H.T', value: formatCurrency(data.total) }];
  if (data.reduction) {
    totals.push({ label: 'Réduction', value: `- ${formatCurrency(data.reduction)}` });
    totals.push({ label: 'Base imposable H.T', value: formatCurrency(base) });
  }
  if (data.tvaEnabled) {
    totals.push({ label: `T.V.A ${data.tvaRate ?? 19} %`, value: formatCurrency(tvaAmount) });
    totals.push({ label: 'Total T.T.C', value: formatCurrency(net), strong: true });
  } else {
    totals.push({ label: 'Net à payer', value: formatCurrency(net), strong: true });
  }
  totals.push({ label: 'Versement', value: formatCurrency(data.paid) });
  totals.push({ label: 'Le rest', value: formatCurrency(data.rest), strong: true });

  const rows: DocRow[] = data.lines.map((l, i) => ({
    cells: [
      String(i + 1),
      l.designation.toUpperCase(),
      l.unit && l.unit.trim() ? l.unit : '/',
      qty(l.quantity),
      formatCurrency(l.unitPrice),
      formatCurrency(l.quantity * l.unitPrice),
    ],
  }));

  printOfficialDocument(
    {
      title: isPurchase ? "FACTURE D'ACHAT" : 'FACTURE DE VENTE',
      docDate: data.date,
      doitLabel: isPurchase ? 'FOURNISSEUR' : 'DOIT',
      doitName: data.partyName,
      doitLines: [
        data.partyAddress ? `ADRESSE : ${data.partyAddress}` : '',
        data.partyPhone ? `TEL : ${data.partyPhone}` : '',
      ].filter(Boolean),
      metaLines: [
        `N° ${data.reference}`,
        `DATE : ${isPurchase ? formatDate(data.date) : formatDateTime(data.date)}`,
        data.bonNumber ? `N° BON : ${data.bonNumber}` : '',
        data.driverPlate ? `MATRICULE : ${data.driverPlate}` : '',
      ].filter(Boolean),
      tables: [
        {
          columns: [
            { label: 'N°', align: 'center', width: '6%' },
            { label: 'Désignation', align: 'left' },
            { label: 'Dosage', align: 'center', width: '9%' },
            { label: 'Quantité', align: 'center', width: '12%' },
            { label: 'Prix unitaire', align: 'right', width: '17%' },
            { label: 'Total', align: 'right', width: '18%' },
          ],
          rows,
          totals,
          emptyLabel: 'Aucun article',
        },
      ],
      amountInWords: amountInWords(net),
      stamps: [
        data.rest > 0
          ? { label: 'Facture à crédit', tone: 'warn' as const }
          : { label: 'Réglée intégralement', tone: 'ok' as const },
        ...(data.historical
          ? [{ label: 'Saisie rétroactive — stock non mouvementé', tone: 'warn' as const }]
          : []),
      ],
      footNotes: [
        data.paid > 0 ? versementLine(data.paid, data.date) : '',
        data.rest > 0 ? `LE REST : ${formatCurrency(data.rest)}` : '',
      ].filter(Boolean),
      signatures: [isPurchase ? 'Le fournisseur' : 'Le client', 'Signature'],
      fileName: `${isPurchase ? 'Facture_Achat' : 'Facture_Vente'}_${data.reference}`,
    },
    store
  );
}
