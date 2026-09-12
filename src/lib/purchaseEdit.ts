import type { Purchase } from '@/types';

/* ============================================================================
 *  MODIFICATION D'UNE FACTURE D'ACHAT — CONTRÔLE DE CE QUE LA BASE A GARDÉ
 * ----------------------------------------------------------------------------
 *  L'écran « Modifier » envoie TOUT à update_purchase() : fournisseur, date,
 *  bon, matricule, lignes de marchandises et règlement.
 *
 *  Une base dont le script SQL n'a pas été exécuté expose encore l'ancienne
 *  version « en-tête seul » de cette fonction : l'appel réussit, mais le
 *  fournisseur et les lignes sont silencieusement ignorés. L'écran annonçait
 *  alors « facture modifiée » alors que rien n'avait bougé — exactement ce que
 *  l'utilisateur voyait.
 *
 *  `ignoredEdits()` relit la facture telle que la base l'a réellement
 *  enregistrée et renvoie, en français, la liste de ce qui n'a PAS été gardé.
 *  Liste vide = la modification est bien enregistrée.
 * ========================================================================== */

/** Ce que l'écran de modification a envoyé — sous-ensemble de UpdatePurchaseInput. */
export interface SubmittedEdit {
  supplierId?: string;
  date?: string;
  bonNumber?: string;
  driverPlate?: string;
  isHistorical?: boolean;
  products?: Purchase['products'];
}

/** Quantité facturée par produit : l'ordre des lignes relues n'est pas garanti. */
function qtyByProduct(lines: Purchase['products']): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.productId, (m.get(l.productId) ?? 0) + Number(l.quantity || 0));
  return m;
}

/** La base arrondit les quantités à 3 décimales et les montants à 2. */
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const plate = (v?: string) => (v || '').trim().toUpperCase();

export function ignoredEdits(saved: Purchase, sent: SubmittedEdit): string[] {
  const out: string[] = [];

  if (sent.supplierId && saved.supplierId !== sent.supplierId) out.push('le fournisseur');
  if (sent.date && saved.date.slice(0, 10) !== sent.date.slice(0, 10)) out.push('la date');
  if (sent.bonNumber !== undefined && (saved.bonNumber || '').trim() !== sent.bonNumber.trim())
    out.push('le n° de bon');
  if (sent.driverPlate !== undefined && plate(saved.driverPlate) !== plate(sent.driverPlate))
    out.push('le matricule');
  if (sent.isHistorical !== undefined && !!saved.isHistorical !== sent.isHistorical)
    out.push('le mode « ancien achat »');

  if (sent.products) {
    const want = qtyByProduct(sent.products);
    const got = qtyByProduct(saved.products);
    const sameQty =
      want.size === got.size &&
      [...want].every(([id, q]) => got.has(id) && near(got.get(id) as number, q));

    // 1 DA de tolérance : seule compte l'écart grossier d'une base qui a gardé
    // les anciennes lignes, jamais un arrondi de centimes.
    const wantTotal = sent.products.reduce((s, l) => s + l.quantity * l.purchasePrice, 0);
    if (!sameQty || !near(saved.totalAmount, wantTotal, 1)) out.push('les produits et les quantités');
  }

  return out;
}
