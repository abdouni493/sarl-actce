// ============================================================================
//  FACTURE DE VENTE
// ----------------------------------------------------------------------------
//  Rendue sur le papier à en-tête officiel de l'entreprise (`officialDoc.ts`),
//  identique au bon de livraison : coordonnées et identifiants fiscaux à
//  GAUCHE, raison sociale + activité au MILIEU, logo à DROITE, mention
//  « <VILLE> LE jj/mm/aaaa », « DOIT : client » à gauche et « N° FACTURE : … »
//  à droite, tableau DÉSIGNATION · ADRESSE DE LIVRAISON · QUANTITÉ · PRIX U ·
//  P.T H.T, totaux TOTAL H.T / TVA / TOTAL T.T.C / VERSEMENT / RESTE À PAYER
//  accrochés à droite, montant en lettres, versements en bas à gauche et
//  « LE CLIENT » / « SIGNATURE » au pied de page.
//
//  La TVA n'apparaît que si elle a été activée sur la vente.
//  Ce fichier exporte aussi `amountInWords()`, utilisé par tous les documents.
// ============================================================================
import type { StoreSettings } from '@/types';
import { formatCurrency, formatDate, formatDateTime } from './utils';
import {
  printOfficialDocument, versementLine,
  type DocRow, type DocTable, type DocTotal,
} from './officialDoc';

export interface InvoiceIngredient {
  productName: string;
  quantityUsed: number;
  unit?: string;
  unitCost?: number;
  lineCost?: number;
}

export interface InvoiceProductionDetail {
  name: string;
  categoryName?: string;
  date?: string;
  hour?: string;
  outputQuantity: number;
  unit?: string;
  unitPrice?: number;
  totalCost?: number;
  ingredients: InvoiceIngredient[];
}

export interface InvoiceLine {
  designation: string;
  description?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  basePrice?: number;
}

export interface SaleInvoiceData {
  reference: string;
  date: string; // ISO
  client: {
    name: string;
    phone?: string;
    address?: string;
    rc?: string;
    nif?: string;
    nis?: string;
    article?: string;
  };
  /** Mode de règlement affiché (ex : « Bancaire », « Espèces »). */
  paymentMode?: string;
  /** Bon de livraison à l'origine de la facture (la livraison EST une vente). */
  deliveryReference?: string;
  /** Commande cliente à l'origine de la livraison facturée. */
  commandReference?: string;
  lines: InvoiceLine[];
  /** Productions launched by this sale (point de vente). */
  productions?: InvoiceProductionDetail[];
  total: number;
  reduction: number;
  /** TVA appliquée à la vente (option activable à la caisse). */
  tvaEnabled?: boolean;
  /** Taux appliqué, en pourcentage (19 par défaut). */
  tvaRate?: number;
  /** Montant de TVA = (total − réduction) × taux / 100. */
  tvaAmount?: number;
  /** Vente antérieure saisie a posteriori (ne touche ni stock ni caisse). */
  historical?: boolean;
  /** Net à payer : TTC quand la TVA est active. */
  final: number;
  paid: number;
  rest: number;
  createdBy?: string;
}

// ------------------------------------------------------------------ helpers --
/** Quantité affichée sans décimale inutile (74,5 · 31 · 1). */
const qty = (n: number, unit?: string) => {
  const v = Number.isInteger(n)
    ? String(n)
    : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
  return unit ? `${v} ${unit}` : v;
};

// ---- Montant en lettres (français) ------------------------------------------
const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

function below100(n: number): string {
  if (n < 20) return UNITS[n];
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (t === 7 || t === 9) {
    const base = TENS[t] + (u === 1 && t === 7 ? '-et-' : '-');
    return base + UNITS[10 + u];
  }
  if (u === 0) return TENS[t] + (t === 8 ? 's' : '');
  if (u === 1 && t !== 8) return `${TENS[t]}-et-un`;
  return `${TENS[t]}-${UNITS[u]}`;
}

function below1000(n: number): string {
  if (n < 100) return below100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h === 1 ? 'cent' : `${UNITS[h]} cent`;
  if (r === 0) return h === 1 ? 'cent' : `${head}s`;
  return `${head} ${below100(r)}`;
}

/** "12 350,50" → "douze mille trois cent cinquante dinars et cinquante centimes". */
export function amountInWords(amount: number): string {
  const value = Math.max(0, Math.round((amount || 0) * 100) / 100);
  const whole = Math.floor(value);
  const cents = Math.round((value - whole) * 100);

  const chunk = (n: number, singular: string, plural: string): string => {
    if (n === 0) return '';
    if (n === 1 && singular === 'mille') return 'mille';
    return `${below1000(n)} ${n > 1 ? plural : singular}`;
  };

  let rest = whole;
  const parts: string[] = [];
  const billions = Math.floor(rest / 1_000_000_000); rest %= 1_000_000_000;
  const millions = Math.floor(rest / 1_000_000); rest %= 1_000_000;
  const thousands = Math.floor(rest / 1000); rest %= 1000;

  if (billions) parts.push(chunk(billions, 'milliard', 'milliards'));
  if (millions) parts.push(chunk(millions, 'million', 'millions'));
  if (thousands) parts.push(chunk(thousands, 'mille', 'mille'));
  if (rest || parts.length === 0) parts.push(below1000(rest));

  const text = parts.filter(Boolean).join(' ');
  const dinars = `${text} ${whole > 1 ? 'dinars' : 'dinar'}`;
  if (!cents) return dinars.charAt(0).toUpperCase() + dinars.slice(1);
  const centWords = `${below100(cents)} ${cents > 1 ? 'centimes' : 'centime'}`;
  const full = `${dinars} et ${centWords}`;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

// --------------------------------------------------------------- rendering --

/**
 * FACTURE DE VENTE — même papier à en-tête officiel que le bon de livraison.
 * La TVA n'est imprimée QUE si elle est activée sur la vente ; les productions
 * déclenchées par la facture (caisse « fiche technique ») sont détaillées dans
 * une seconde section, avec leurs matières consommées.
 */
export function printSaleInvoice(data: SaleInvoiceData, store: StoreSettings) {
  const baseHT = Math.max(0, (data.total || 0) - (data.reduction || 0));
  const tvaRate = data.tvaEnabled ? (data.tvaRate ?? 0) : 0;
  const tvaAmount = data.tvaEnabled
    ? (data.tvaAmount ?? Math.round(baseHT * tvaRate) / 100)
    : 0;

  const totals: DocTotal[] = [{ label: 'Total H.T', value: formatCurrency(data.total) }];
  if (data.reduction) {
    totals.push({ label: 'Réduction', value: `- ${formatCurrency(data.reduction)}` });
    totals.push({ label: 'Base imposable H.T', value: formatCurrency(baseHT) });
  }
  if (data.tvaEnabled) {
    totals.push({ label: `T.V.A ${tvaRate} %`, value: formatCurrency(tvaAmount) });
    totals.push({ label: 'Total T.T.C', value: formatCurrency(data.final), strong: true });
  } else {
    totals.push({ label: 'Net à payer', value: formatCurrency(data.final), strong: true });
  }
  totals.push({ label: 'Versement', value: formatCurrency(data.paid) });
  totals.push({ label: 'Reste à payer', value: formatCurrency(data.rest), strong: true });

  // Colonne « ADRESSE DE LIVRAISON » du modèle papier.
  const address = (data.client.address || '').trim();

  const lineRows: DocRow[] = data.lines.map((l, i) => ({
    cells: [
      String(i + 1),
      l.designation.toUpperCase() + (l.description ? ` — ${l.description}` : ''),
      (address || '/').toUpperCase(),
      qty(l.quantity, l.unit),
      formatCurrency(l.unitPrice),
      formatCurrency(l.quantity * l.unitPrice),
    ],
  }));

  const tables: DocTable[] = [
    {
      columns: [
        { label: 'N°', align: 'center', width: '6%' },
        { label: 'Désignation', align: 'left' },
        { label: 'Adresse de livraison', align: 'left', width: '21%' },
        { label: 'Quantité', align: 'center', width: '12%' },
        { label: 'Prix U', align: 'right', width: '16%' },
        { label: 'P.T H.T', align: 'right', width: '17%' },
      ],
      rows: lineRows,
      totals,
      emptyLabel: 'Aucun article facturé',
    },
  ];

  // Productions lancées par la vente — chaque lot et ses matières consommées.
  (data.productions ?? []).forEach((p) => {
    tables.push({
      title: `Production : ${p.name}${p.categoryName ? ` (${p.categoryName})` : ''}`,
      columns: [
        { label: 'Matière consommée', align: 'left' },
        { label: 'Dosage', align: 'center', width: '10%' },
        { label: 'Quantité', align: 'center', width: '13%' },
        { label: 'Coût unitaire', align: 'right', width: '17%' },
        { label: 'Total', align: 'right', width: '18%' },
      ],
      rows: p.ingredients.map((i) => ({
        cells: [
          i.productName.toUpperCase(),
          i.unit && i.unit.trim() ? i.unit : '/',
          qty(i.quantityUsed),
          formatCurrency(i.unitCost ?? 0),
          formatCurrency(i.lineCost ?? i.quantityUsed * (i.unitCost ?? 0)),
        ],
      })),
      totals: [
        {
          label: `Quantité produite : ${qty(p.outputQuantity)}${p.unit ? ` ${p.unit}` : ''}`,
          value: formatCurrency(p.totalCost ?? 0),
          strong: true,
        },
      ],
      emptyLabel: 'Aucune matière détaillée',
      note: p.date ? `Lot du ${formatDate(p.date)}${p.hour ? ` à ${p.hour}` : ''}` : undefined,
    });
  });

  printOfficialDocument(
    {
      title: data.tvaEnabled ? 'FACTURE DE VENTE (T.T.C)' : 'FACTURE DE VENTE',
      docDate: data.date,
      doitName: data.client.name,
      doitLines: [
        data.client.address ? `ADRESSE : ${data.client.address}` : '',
        data.client.rc ? `R.C N° : ${data.client.rc}` : '',
        data.client.nif ? `NIF : ${data.client.nif}` : '',
        data.client.nis ? `NIS : ${data.client.nis}` : '',
        data.client.article ? `N° ARTICLE : ${data.client.article}` : '',
        data.client.phone ? `TEL : ${data.client.phone}` : '',
      ].filter(Boolean),
      metaLines: [
        `N° FACTURE : ${data.reference}`,
        `DATE : ${formatDateTime(data.date)}`,
        data.deliveryReference ? `BON DE LIVRAISON : ${data.deliveryReference}` : '',
        data.commandReference ? `COMMANDE : ${data.commandReference}` : '',
        data.paymentMode ? `RÈGLEMENT : ${data.paymentMode}` : '',
        data.createdBy ? `ÉTABLIE PAR : ${data.createdBy}` : '',
      ].filter(Boolean),
      tables,
      amountInWords: amountInWords(data.final),
      stamps: [
        data.rest > 0
          ? { label: 'Vente à crédit', tone: 'warn' as const }
          : { label: 'Réglée intégralement', tone: 'ok' as const },
        ...(data.tvaEnabled ? [] : [{ label: 'Facture sans TVA', tone: 'ok' as const }]),
        ...(data.historical ? [{ label: 'Vente antérieure — saisie rétroactive', tone: 'warn' as const }] : []),
        ...(data.deliveryReference ? [{ label: 'Issue d’un bon de livraison', tone: 'ok' as const }] : []),
      ],
      footNotes: [
        data.paid > 0 ? versementLine(data.paid, data.date) : '',
        data.rest > 0 ? `RESTE À PAYER : ${formatCurrency(data.rest)}` : '',
      ].filter(Boolean),
      signatures: ['Le client', 'Signature'],
      fileName: `Facture_${data.reference}`,
    },
    store
  );
}
