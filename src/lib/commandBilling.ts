import type { Sale } from '@/types';
import type { Command } from '@/store/commandStore';

/* ============================================================================
 *  COMMANDE vs LIVRAISON — NE JAMAIS COMPTER DEUX FOIS LE MÊME ARGENT
 * ----------------------------------------------------------------------------
 *  Depuis la mise à jour « la livraison est une vente », chaque bon de
 *  livraison génère une FACTURE DE VENTE dans l'historique des ventes. La
 *  commande, elle, reste l'engagement pris par le client.
 *
 *  Une commande entièrement livrée est donc déjà entièrement facturée par ses
 *  ventes : la reprendre telle quelle dans les totaux gonflerait le chiffre
 *  d'affaires et la dette du client du double.
 *
 *  Règle appliquée partout (fiche client, compte rendu, caisse, rapports) :
 *
 *      part encore « commande » = commande TTC − ventes de ses livraisons
 *
 *  · commande non livrée      → elle compte pour son TTC (rien n'est facturé)
 *  · commande partiellement livrée → la part livrée compte comme VENTE, le
 *    solde reste une commande en attente
 *  · commande soldée par ses livraisons → elle ne compte plus, seules ses
 *    ventes comptent
 * ========================================================================== */

export interface CommandNet {
  /** Reste à facturer sur la commande (hors ce qui est déjà devenu vente). */
  billed: number;
  /** Versements du client encore rattachés à la commande (acompte non imputé). */
  paid: number;
  /** Reste dû au titre de la commande seule. */
  rest: number;
}

const ZERO: CommandNet = { billed: 0, paid: 0, rest: 0 };

/** Total TTC d'une commande — retombe sur le HT si la base n'a pas la colonne. */
export function commandTtc(cmd: Command): number {
  return cmd.totalTtc && cmd.totalTtc > 0 ? cmd.totalTtc : cmd.totalAmount;
}

/** Les ventes engendrées par les livraisons d'une commande. */
export function deliverySalesOf(commandId: string, sales: Sale[]): Sale[] {
  return sales.filter((s) => !!s.deliveryId && s.commandId === commandId);
}

/** Une vente issue d'un bon de livraison (badge « Livraison » dans /ventes). */
export const isDeliverySale = (s: Sale) => !!s.deliveryId;

/**
 * Part d'une commande qui n'a PAS encore été transformée en facture de vente.
 * C'est elle — et elle seule — qui doit s'ajouter aux ventes dans les totaux.
 */
export function netCommand(cmd: Command, sales: Sale[]): CommandNet {
  const linked = deliverySalesOf(cmd.id, sales);
  const invoiced = linked.reduce((s, x) => s + x.finalAmount, 0);
  const invoicedPaid = linked.reduce((s, x) => s + x.paidAmount, 0);
  const billed = Math.max(0, commandTtc(cmd) - invoiced);
  const paid = Math.max(0, cmd.paidAmount - invoicedPaid);
  return { billed, paid, rest: Math.max(0, billed - paid) };
}

/** Cumul de `netCommand()` sur une liste de commandes. */
export function netCommandTotals(commands: Command[], sales: Sale[]): CommandNet {
  return commands.reduce<CommandNet>((acc, cmd) => {
    const n = netCommand(cmd, sales);
    return { billed: acc.billed + n.billed, paid: acc.paid + n.paid, rest: acc.rest + n.rest };
  }, { ...ZERO });
}
