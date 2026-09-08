import { useEffect, useMemo, useState } from 'react';
import {
  FileBarChart, Printer, Receipt, Coins, RotateCcw, Package, Boxes, History, Undo2, PiggyBank,
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PeriodPicker, ReportKpis, ReportSection, firstDayOfMonth, inPeriod } from './PeriodReport';
import { usePurchaseStore } from '@/store/purchaseStore';
import { useSupplierStore } from '@/store/supplierStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useLanguage } from '@/hooks/useLanguage';
import { formatCurrency, formatDate, formatDateTime, todayISO, paymentMethodLabel } from '@/lib/utils';
import { computePartyBalance } from '@/lib/partyBalance';
import { printDetailedReport, type PrintRow, type PrintTableSection } from '@/lib/reportPrint';
import type { Supplier } from '@/types';

/** Quantité affichée sans décimales inutiles (12 et non 12.0000). */
const qty = (n: number) => Number(n.toFixed(3)).toLocaleString('fr-FR');

/**
 * Compte rendu d'un fournisseur sur une période : factures d'achat, détail
 * des marchandises reçues, RÉCAPITULATIF DES QUANTITÉS PAR PRODUIT et
 * versements effectués — affiché à l'écran puis imprimable sur le modèle
 * professionnel de l'entreprise.
 */
export function SupplierStatementModal({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const { language } = useLanguage();
  const purchases = usePurchaseStore((s) => s.purchases);
  const payments = useSupplierStore((s) => s.payments);
  const supplierRows = useSupplierStore((s) => s.suppliers);
  const oldDebts = useSupplierStore((s) => s.oldDebts);
  const refunds = useSupplierStore((s) => s.refunds);
  const settings = useSettingsStore((s) => s.settings);

  const [from, setFrom] = useState(firstDayOfMonth());
  const [to, setTo] = useState(todayISO());
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);

  // Un compte rendu appartient à UN fournisseur : à l'ouverture d'une autre
  // fiche on repart d'une période vierge, sinon l'écran affiche encore le
  // rapport généré pour le fournisseur précédent.
  useEffect(() => {
    if (!supplier) return;
    setFrom(firstDayOfMonth());
    setTo(todayISO());
    setPeriod(null);
  }, [supplier?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!supplier || !period) return null;
    const { from: f, to: t } = period;

    const purchasesList = purchases
      .filter((p) => p.supplierId === supplier.id && inPeriod(p.date, f, t))
      .sort((a, b) => a.date.localeCompare(b.date));

    const paymentsList = payments
      .filter((p) => p.partyId === supplier.id && inPeriod(p.paidAt, f, t))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt));

    // ANCIENNES DETTES (sommes deja dues avant le logiciel) de la periode
    const oldDebtsList = oldDebts
      .filter((d) => d.partyId === supplier.id && inPeriod(d.date, f, t))
      .sort((a, b) => a.date.localeCompare(b.date));

    // TROP-VERSES recuperes aupres du fournisseur (entree de caisse)
    const refundsList = refunds
      .filter((r) => r.partyId === supplier.id && inPeriod(r.refundedAt, f, t))
      .sort((a, b) => a.refundedAt.localeCompare(b.refundedAt));

    const total = purchasesList.reduce((s, x) => s + x.totalAmount, 0);
    const paid = purchasesList.reduce((s, x) => s + x.paidAmount, 0);
    const rest = purchasesList.reduce((s, x) => s + x.restAmount, 0);
    const settled = paymentsList.reduce((s, x) => s + x.amount, 0);
    const lines = purchasesList.reduce((s, x) => s + x.products.length, 0);

    const oldDebtsTotal = oldDebtsList.reduce((s, x) => s + x.amount, 0);
    const oldDebtsPaid = oldDebtsList.reduce((s, x) => s + x.paidAmount, 0);
    const oldDebtsRest = oldDebtsList.reduce((s, x) => s + x.restAmount, 0);
    const refunded = refundsList.reduce((s, x) => s + x.amount, 0);

    // ---- SITUATION ACTUELLE DU COMPTE (toutes periodes confondues) --------
    const allPurchases = purchases.filter((x) => x.supplierId === supplier.id);
    const allOldDebts = oldDebts.filter((d) => d.partyId === supplier.id);
    const account = computePartyBalance({
      documentsBilled: allPurchases.reduce((s, x) => s + x.totalAmount, 0),
      documentsPaid: allPurchases.reduce((s, x) => s + x.paidAmount, 0),
      documentsRest: allPurchases.reduce((s, x) => s + x.restAmount, 0),
      oldDebts: allOldDebts,
      credit: supplierRows.find((x) => x.id === supplier.id)?.creditAmount ?? 0,
    });

    // ---- Récapitulatif : quantité reçue de CHAQUE produit sur la période ----
    const byProduct = new Map<
      string,
      { name: string; unit?: string; quantity: number; amount: number; invoices: Set<string> }
    >();
    purchasesList.forEach((p) =>
      p.products.forEach((l) => {
        const name = (l.productName || '—').trim();
        const key = `${name.toLowerCase()}|${l.unit ?? ''}`;
        const cur = byProduct.get(key) ?? {
          name, unit: l.unit, quantity: 0, amount: 0, invoices: new Set<string>(),
        };
        cur.quantity += l.quantity;
        cur.amount += l.quantity * l.purchasePrice;
        cur.invoices.add(p.reference);
        byProduct.set(key, cur);
      })
    );
    const products = [...byProduct.values()]
      .map((x) => ({
        ...x,
        invoiceCount: x.invoices.size,
        avgPrice: x.quantity > 0 ? x.amount / x.quantity : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    const productsQty = products.reduce((s, x) => s + x.quantity, 0);
    const productsAmount = products.reduce((s, x) => s + x.amount, 0);

    return {
      purchasesList, paymentsList, products, oldDebtsList, refundsList,
      total, paid, rest, settled, lines, productsQty, productsAmount,
      oldDebtsTotal, oldDebtsPaid, oldDebtsRest, refunded, account,
      billed: total + oldDebtsTotal,
      outstanding: rest + oldDebtsRest,
    };
  }, [supplier, period, purchases, payments, oldDebts, refunds, supplierRows]);

  const periodLabel = period
    ? `Du ${formatDate(period.from, language)} au ${formatDate(period.to, language)}`
    : '';

  /**
   * COMPTE RENDU FOURNISSEUR — document volontairement DÉPOUILLÉ : la
   * marchandise reçue avec sa QUANTITÉ, son PRIX UNITAIRE et son MONTANT, puis
   * TOTAL H.T, T.V.A, TOTAL T.T.C, VERSEMENT et LE REST. Le détail facture par
   * facture reste consultable à l'écran mais n'est plus imprimé.
   */
  const doPrint = () => {
    if (!supplier || !data || !period) return;

    // Une ligne par produit ET par prix d'achat pratiqué sur la période.
    const grouped = new Map<
      string,
      { name: string; unit?: string; quantity: number; unitPrice: number; amount: number }
    >();
    data.purchasesList.forEach((p) =>
      p.products.forEach((l) => {
        if (!(l.quantity > 0)) return;
        const name = (l.productName || '—').trim();
        const key = `${name.toLowerCase()}|${l.unit ?? ''}|${l.purchasePrice}`;
        const cur = grouped.get(key) ?? {
          name, unit: l.unit, quantity: 0, unitPrice: l.purchasePrice, amount: 0,
        };
        cur.quantity += l.quantity;
        cur.amount += l.quantity * l.purchasePrice;
        grouped.set(key, cur);
      })
    );
    const lines = [...grouped.values()].sort((a, b) => b.amount - a.amount);

    const ht = lines.reduce((s, l) => s + l.amount, 0);
    // Les factures d'achat sont saisies hors taxes : pas de TVA récupérable.
    const tva = 0;
    const ttc = ht + tva;
    const paid = data.paid + data.settled;
    const rest = data.outstanding;

    const section: PrintTableSection = {
      title: 'Marchandises reçues sur la période',
      cols: [
        { label: 'Désignation' },
        { label: 'Quantité', align: 'right' },
        { label: 'Prix unitaire', align: 'right' },
        { label: 'Total', align: 'right' },
      ],
      rows: [
        ...lines.map<PrintRow>((l) => ({
          cells: [
            l.name.toUpperCase(),
            `${qty(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`,
            formatCurrency(l.unitPrice),
            formatCurrency(l.amount),
          ],
        })),
        { cells: ['TOTAL H.T', '', '', formatCurrency(ht)], variant: 'subtotal' },
        { cells: ['T.V.A', '', '', formatCurrency(tva)], variant: 'subtotal' },
        { cells: ['TOTAL T.T.C', '', '', formatCurrency(ttc)], variant: 'total' },
        { cells: ['VERSEMENT', '', '', formatCurrency(paid)], variant: 'subtotal' },
        { cells: ['LE REST', '', '', formatCurrency(rest)], variant: 'total' },
      ],
      emptyLabel: 'Aucune marchandise reçue sur la période',
    };

    printDetailedReport(
      {
        docTitle: `Compte rendu ${supplier.name}`,
        headTitle: 'COMPTE RENDU FOURNISSEUR',
        subtitle: periodLabel,
        meta: [{ label: 'Fournisseur', value: supplier.name }],
        sections: [section],
      },
      settings,
      language
    );
  };

  return (
    <Modal open={!!supplier} onClose={onClose} title={`Compte rendu — ${supplier?.name ?? ''}`} size="lg">
      {supplier && (
        <div className="space-y-5">
          <PeriodPicker
            from={from}
            to={to}
            onChange={(f, t) => { setFrom(f); setTo(t); setPeriod(null); }}
            onGenerate={() => setPeriod({ from, to })}
          />

          {!data ? (
            <div className="rounded-2xl border border-dashed border-gold/25 bg-vanilla/20 py-10 text-center">
              <FileBarChart size={34} className="mx-auto text-gold opacity-60 mb-3" />
              <p className="text-sm text-text-muted">
                Choisissez une date de début et une date de fin, puis générez le compte rendu.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-display text-base font-semibold text-text-primary">{supplier.name}</p>
                  <p className="text-xs text-text-muted">{periodLabel}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setPeriod(null)}>
                    <RotateCcw size={14} /> Changer la période
                  </Button>
                  <Button size="sm" variant="gold" onClick={doPrint}>
                    <Printer size={14} /> Imprimer le compte rendu
                  </Button>
                </div>
              </div>

              {/* On lui a paye PLUS que du : le solde est en faveur de l'entreprise */}
              {data.account.hasCredit && (
                <div className="flex items-start gap-3 rounded-2xl border border-pistachio/40 bg-pistachio/10 px-4 py-3">
                  <PiggyBank size={20} className="shrink-0 mt-0.5 text-pistachio" />
                  <div>
                    <p className="text-sm font-bold text-pistachio">
                      Solde en faveur de l&rsquo;entreprise : + {formatCurrency(data.account.creditToReturn)}
                    </p>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {supplier.name} a été payé plus que dû. Utilisez « Récupérer l&rsquo;excédent »
                      sur sa carte pour enregistrer la restitution.
                    </p>
                  </div>
                </div>
              )}

              <ReportKpis
                items={[
                  { label: 'Total acheté', value: formatCurrency(data.total), color: 'text-gold-dark' },
                  { label: 'Payé sur factures', value: formatCurrency(data.paid), color: 'text-pistachio' },
                  { label: 'Reste dû (période)', value: formatCurrency(data.outstanding), color: 'text-rose-deep' },
                  { label: 'Versements effectués', value: formatCurrency(data.settled), color: 'text-pistachio' },
                  { label: 'Anciennes dettes', value: formatCurrency(data.oldDebtsTotal), color: 'text-gold-dark' },
                  { label: 'Excédent récupéré', value: formatCurrency(data.refunded), color: 'text-pistachio' },
                  {
                    label: data.account.hasCredit ? 'Solde en notre faveur' : 'Solde dû (compte)',
                    value: data.account.hasCredit
                      ? `+ ${formatCurrency(data.account.creditToReturn)}`
                      : formatCurrency(Math.max(0, data.account.net)),
                    color: data.account.hasCredit ? 'text-pistachio' : 'text-rose-deep',
                  },
                  { label: 'Factures', value: String(data.purchasesList.length) },
                  { label: 'Lignes reçues', value: String(data.lines) },
                  { label: 'Produits distincts', value: String(data.products.length) },
                  { label: 'Quantité totale reçue', value: qty(data.productsQty), color: 'text-gold-dark' },
                ]}
              />

              <ReportSection
                title="Factures d'achat" icon={<Receipt size={14} />}
                total={formatCurrency(data.total)}
                head={['N° facture', 'Date', 'Bon n°', 'Matricule', 'Total', 'Payé', 'Reste']}
                empty="Aucune facture sur cette période"
                rows={data.purchasesList.map((p) => [
                  <span key="r" className="font-semibold">
                    {p.reference}
                    {p.isHistorical && (
                      <span className="ml-1.5 text-[10px] font-medium text-gold-dark">(ancien achat)</span>
                    )}
                  </span>,
                  formatDate(p.date, language),
                  p.bonNumber || '—',
                  p.driverPlate || '—',
                  formatCurrency(p.totalAmount),
                  <span key="p" className="text-pistachio">{formatCurrency(p.paidAmount)}</span>,
                  <span key="x" className={p.restAmount > 0 ? 'text-rose-deep font-bold' : 'text-pistachio'}>
                    {formatCurrency(p.restAmount)}
                  </span>,
                ])}
              />

              <ReportSection
                title="Quantités reçues par produit" icon={<Boxes size={14} />}
                total={formatCurrency(data.productsAmount)}
                note="Cumul de toutes les factures de la période, produit par produit."
                head={['Produit', 'Quantité totale', 'Unité', 'Factures', 'Prix moyen', 'Montant']}
                empty="Aucun produit reçu sur cette période"
                rows={data.products.map((x) => [
                  <span key="n" className="font-semibold">{x.name}</span>,
                  <span key="q" className="font-bold text-gold-dark">{qty(x.quantity)}</span>,
                  x.unit || '—',
                  String(x.invoiceCount),
                  formatCurrency(x.avgPrice),
                  formatCurrency(x.amount),
                ])}
              />

              <ReportSection
                title="Marchandises reçues" icon={<Package size={14} />}
                head={['Facture · Produit', 'Quantité', "Prix d'achat", 'Montant']}
                empty="Aucune marchandise reçue sur cette période"
                rows={data.purchasesList.flatMap((p) =>
                  p.products.map((l) => [
                    <span key="n">
                      <span className="text-text-muted">{p.reference}</span> · {l.productName}
                    </span>,
                    `${qty(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`,
                    formatCurrency(l.purchasePrice),
                    formatCurrency(l.quantity * l.purchasePrice),
                  ])
                )}
              />

              <ReportSection
                title="Anciennes dettes" icon={<History size={14} />}
                total={formatCurrency(data.oldDebtsTotal)}
                note="Sommes dues au fournisseur avant le logiciel — aucune écriture de caisse à leur saisie."
                head={['Date', 'Description', 'Montant', 'Réglé', 'Reste']}
                empty="Aucune ancienne dette sur cette période"
                rows={data.oldDebtsList.map((d) => [
                  formatDate(d.date, language),
                  <span key="d" className="font-semibold">{d.description || '—'}</span>,
                  formatCurrency(d.amount),
                  <span key="p" className="text-pistachio">{formatCurrency(d.paidAmount)}</span>,
                  <span key="r" className={d.restAmount > 0 ? 'text-rose-deep font-bold' : 'text-pistachio'}>
                    {formatCurrency(d.restAmount)}
                  </span>,
                ])}
              />

              <ReportSection
                title="Excédents récupérés" icon={<Undo2 size={14} />}
                total={formatCurrency(data.refunded)}
                note="Argent rendu par le fournisseur parce qu'il avait été payé en trop — entrée de caisse."
                head={['Date et heure', 'Reçu n°', 'Mode de règlement', 'Note', 'Montant récupéré']}
                empty="Aucun excédent récupéré sur cette période"
                rows={data.refundsList.map((r) => [
                  formatDateTime(r.refundedAt, language),
                  `EXC-${r.id.slice(0, 8).toUpperCase()}`,
                  paymentMethodLabel(r),
                  r.notes || '—',
                  <span key="a" className="font-bold text-pistachio">+ {formatCurrency(r.amount)}</span>,
                ])}
              />

              <ReportSection
                title="Versements effectués" icon={<Coins size={14} />}
                total={formatCurrency(data.settled)}
                head={['Date et heure', 'Reçu n°', 'Mode de règlement', 'Note', 'Montant']}
                empty="Aucun versement sur cette période"
                rows={data.paymentsList.map((p) => [
                  formatDateTime(p.paidAt, language),
                  `RGF-${p.id.slice(0, 8).toUpperCase()}`,
                  paymentMethodLabel(p),
                  p.notes || '—',
                  <span key="a" className="font-bold text-pistachio">{formatCurrency(p.amount)}</span>,
                ])}
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
