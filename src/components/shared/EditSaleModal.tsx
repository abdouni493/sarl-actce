import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/utils';
import type { Sale } from '@/types';

/**
 * Modification d'une facture de vente déjà enregistrée (historique client).
 * Seul l'en-tête commercial est modifiable — date, réduction et montant payé :
 * les lignes ont déjà décrémenté le comptoir, elles ne sont pas rejouées.
 * Le reste dû, le statut, l'écriture de caisse et la dette client sont
 * recalculés par la base de données.
 *
 * Cas particulier : une facture issue d'un BON DE LIVRAISON. Livraison et vente
 * sont la même opération — la base répercute donc la modification sur le bon
 * (date, encaissement) puis reconstruit la facture. La réduction n'existe pas
 * sur ce type de facture : le montant vient des quantités réellement remises.
 */
export function EditSaleModal({
  sale, onClose, onSave,
}: {
  sale: Sale | null;
  onClose: () => void;
  onSave: (data: { date: string; reduction: number; paidAmount: number; note?: string }) => Promise<void>;
}) {
  const [date, setDate] = useState('');
  const [reduction, setReduction] = useState(0);
  const [paidAmount, setPaidAmount] = useState(0);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sale) return;
    setDate(sale.date.slice(0, 10));
    setReduction(sale.reduction);
    setPaidAmount(sale.paidAmount);
    setNote('');
  }, [sale]);

  const fromDelivery = !!sale?.deliveryId;
  const total = sale?.totalAmount ?? 0;
  const baseHT = Math.max(0, total - Math.min(fromDelivery ? 0 : reduction, total));
  const tvaAmount = sale?.tvaEnabled ? Math.round(baseHT * (sale.tvaRate ?? 19)) / 100 : 0;
  const finalAmount = baseHT + tvaAmount;
  const rest = Math.max(0, finalAmount - Math.min(paidAmount, finalAmount));

  return (
    <Modal open={!!sale} onClose={onClose} title={`Modifier la vente ${sale?.reference ?? ''}`} size="sm">
      <div className="space-y-4">
        <div className="rounded-xl border border-gold/15 bg-vanilla/40 px-3.5 py-2.5 text-xs text-text-secondary">
          <div className="flex justify-between">
            <span>Total des articles H.T</span>
            <span className="tabular font-bold text-text-primary">{formatCurrency(total)}</span>
          </div>
          {sale?.tvaEnabled && (
            <div className="flex justify-between mt-0.5">
              <span>TVA {sale.tvaRate} %</span>
              <span className="tabular font-bold text-gold-dark">+ {formatCurrency(tvaAmount)}</span>
            </div>
          )}
          <p className="mt-1 text-[11px] italic text-text-muted">
            {fromDelivery
              ? "Facture issue d'un bon de livraison : le montant vient des quantités remises. Le montant payé saisi ici met à jour l'encaissement du bon et la caisse."
              : 'Les lignes de la vente ne sont pas modifiables ici : le stock du comptoir a déjà été décrémenté.'}
          </p>
        </div>

        <Input label="Date de la vente" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {!fromDelivery && (
          <Input
            label="Réduction (DA)" type="number" step="any" min={0}
            value={reduction} onChange={(e) => setReduction(Math.max(0, Number(e.target.value)))}
          />
        )}
        <Input
          label="Montant payé (DA)" type="number" step="any" min={0}
          value={paidAmount} onChange={(e) => setPaidAmount(Math.max(0, Number(e.target.value)))}
        />
        <Textarea label="Note (facultatif)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-gold/15 bg-vanilla/40 p-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-text-muted">Net à payer</p>
            <p className="text-sm font-bold tabular text-gold-dark">{formatCurrency(finalAmount)}</p>
          </div>
          <div className="rounded-xl border border-gold/15 bg-vanilla/40 p-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-text-muted">Reste dû</p>
            <p className={`text-sm font-bold tabular ${rest > 0 ? 'text-rose-deep' : 'text-pistachio'}`}>
              {formatCurrency(rest)}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Annuler</Button>
          <Button
            variant="gold"
            disabled={saving || !date}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave({ date, reduction, paidAmount, note: note.trim() || undefined });
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
