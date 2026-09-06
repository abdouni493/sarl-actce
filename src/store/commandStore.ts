import { create } from 'zustand';
import type { CommandDelivery, CommandDeliveryItem } from '@/types';
import { db, rpc } from '@/lib/db';
import { save } from '@/lib/persist';
import { useStockStore } from './stockStore';
import { useSalesStore } from './salesStore';

export interface CommandItem {
  /** database id of the line — needed to attribute a delivery to it */
  id?: string;
  productId?: string;
  productName: string;
  quantity: number;
  /** quantity already delivered across every "Livraison" of the command */
  deliveredQuantity?: number;
  unitPrice: number;
  totalPrice: number;
  sellByUnit?: boolean;
  sellUnit?: string;
  ficheTechnicId?: string;
}

export type CommandLine = CommandItem;

export interface Command {
  id: string;
  reference: string;
  /** N° de bon de commande saisi manuellement (repère client, recherche). */
  bonNumber?: string;
  createdAt: string;
  receiveDate: string;
  receiveHour: string;
  receiveMinute: string;
  clientId: string;
  clientName: string;
  clientPhone?: string;
  /** Adresse de livraison — saisie obligatoirement à chaque commande. */
  clientAddress?: string;
  /** Chauffeur prévu pour emmener la commande. */
  driverName?: string;
  /** Immatriculation du camion — facultative. */
  driverPlate?: string;
  items: CommandItem[];
  /** Total HORS TAXES des lignes de la commande. */
  totalAmount: number;
  /** TVA activee sur la commande — reprise par defaut sur chaque livraison. */
  tvaEnabled?: boolean;
  /** Taux applique en pourcentage (19 % par defaut). */
  tvaRate?: number;
  /** Montant de TVA = total HT x taux / 100. */
  tvaAmount?: number;
  /** Net a payer : total HT + TVA. C'est lui qui determine le reste du. */
  totalTtc?: number;
  advancePaid: number;
  /** Reglements encaisses depuis l'ecran « Commandes » (hors acompte). */
  extraPaid?: number;
  paidAmount: number;
  restAmount: number;
  status: 'pending' | 'finalised' | 'cancelled';
  /**
   * « Ancienne commande » : commande antérieure saisie a posteriori pour
   * reconstituer l'historique d'un client. Rien n'est déduit du stock, aucune
   * production n'est lancée et aucune écriture de caisse n'est générée — seule
   * la statistique commerciale (client, dette, rapports) est alimentée.
   */
  isHistorical?: boolean;
  notes?: string;
  createdBy: string;
}

export type AddCommandInput = Omit<
  Command,
  'id' | 'reference' | 'createdAt' | 'paidAmount' | 'restAmount' | 'status' | 'createdBy' | 'advancePaid'
  | 'totalTtc' | 'tvaAmount' | 'extraPaid'
> & {
  createdBy?: string;
  advancePaid?: number;
  paidAmount?: number;
  /** Optional manual creation date (ISO) — lets the POS back-date a command. */
  createdAt?: string;
};

/** Ordered vs delivered summary of a command — drives the card alert. */
export function deliveryStatus(cmd: Command) {
  const ordered = cmd.items.reduce((s, i) => s + i.quantity, 0);
  const delivered = cmd.items.reduce((s, i) => s + (i.deliveredQuantity ?? 0), 0);
  const remaining = Math.max(0, ordered - delivered);
  return {
    ordered,
    delivered,
    remaining,
    isFull: ordered > 0 && remaining <= 0.0001,
    isPartial: delivered > 0 && remaining > 0.0001,
    percent: ordered > 0 ? Math.min(100, (delivered / ordered) * 100) : 0,
  };
}

interface CommandState {
  commands: Command[];
  deliveries: CommandDelivery[];
  load: () => Promise<void>;
  addCommand: (c: AddCommandInput) => Promise<Command>;
  /** Returns false when the product lines were kept because a delivery exists. */
  updateCommand: (id: string, data: Partial<Command>) => Promise<boolean>;
  payDebt: (commandId: string, amount: number, date?: string) => Promise<void>;
  updateStatus: (commandId: string, status: Command['status']) => Promise<void>;
  deleteCommand: (id: string) => Promise<void>;
  // ---- livraisons ----
  addDelivery: (
    commandId: string,
    items: CommandDeliveryItem[],
    deliveredAt: string,
    notes?: string,
    driver?: DeliveryDriver,
    payment?: DeliveryPayment
  ) => Promise<CommandDelivery>;
  updateDelivery: (
    id: string,
    items: CommandDeliveryItem[],
    deliveredAt: string,
    notes?: string,
    driver?: DeliveryDriver,
    payment?: DeliveryPayment
  ) => Promise<void>;
  deleteDelivery: (id: string) => Promise<void>;
}

/** Chauffeur et lieu d'une livraison — repris de la commande ou saisis à la volée. */
export interface DeliveryPayment {
  /** TVA appliquee a ce bon (par defaut celle de la commande). */
  tvaEnabled?: boolean;
  tvaRate?: number;
  /** Argent reellement encaisse au moment de la remise (entre en caisse). */
  cashPaid?: number;
  /** Part de l'acompte de la commande imputee ici (n'entre pas en caisse). */
  advanceApplied?: number;
}

export interface DeliveryDriver {
  driverName?: string;
  driverPlate?: string;
  /** Lieu réellement livré pour ce bon (défaut : adresse de la commande). */
  location?: string;
}

const itemPayload = (i: CommandItem) => ({
  product_id: i.productId ?? null,
  fiche_technic_id: i.ficheTechnicId ?? null,
  product_name: i.productName,
  quantity: i.quantity,
  unit_price: i.unitPrice,
  total_price: i.totalPrice,
  sell_by_unit: i.sellByUnit ?? false,
  sell_unit: i.sellUnit ?? null,
});

const deliveryItemPayload = (i: CommandDeliveryItem) => ({
  command_item_id: i.commandItemId ?? null,
  product_name: i.productName,
  quantity: i.quantity,
  sell_unit: i.sellUnit ?? null,
});

/** Recharge « Gestion de stock » après un mouvement déclenché par une livraison. */
const reloadStock = () =>
  useStockStore.getState().load().catch(() => undefined);

/** Option TVA envoyee a la base — omise quand l'appelant ne la precise pas. */
const tvaPayload = (p?: DeliveryPayment) =>
  p?.tvaEnabled === undefined
    ? {}
    : { tva_enabled: p.tvaEnabled, tva_rate: p.tvaEnabled ? (p.tvaRate ?? 19) : 0 };

/**
 * Une livraison EST une vente : la facture qu'elle genere doit apparaitre
 * immediatement dans « Ventes », dans la caisse et sur la fiche du client.
 */
const reloadSales = () =>
  useSalesStore.getState().load().catch(() => undefined);

export const useCommandStore = create<CommandState>()((set, get) => ({
  commands: [],
  deliveries: [],

  load: async () => {
    const [commands, deliveries] = await Promise.all([
      db.commands.list(), db.commandDeliveries.list(),
    ]);
    set({ commands, deliveries });
  },

  addCommand: async (data) => {
    const advance = data.advancePaid ?? data.paidAmount ?? 0;
    const row = await save('commands.create', () =>
      rpc.createCommand({
        client_id: data.clientId,
        client_name: data.clientName,
        client_phone: data.clientPhone ?? null,
        client_address: data.clientAddress ?? null,
        driver_name: data.driverName ?? null,
        driver_plate: data.driverPlate ?? null,
        receive_date: data.receiveDate || null,
        receive_hour: data.receiveHour,
        receive_minute: data.receiveMinute,
        total_amount: data.totalAmount,
        tva_enabled: data.tvaEnabled ?? false,
        tva_rate: data.tvaEnabled ? (data.tvaRate ?? 19) : 0,
        advance_paid: advance,
        notes: data.notes ?? null,
        bon_number: data.bonNumber ?? null,
        is_historical: data.isHistorical ?? false,
        created_at: data.createdAt ?? null,
        items: data.items.map(itemPayload),
      })
    );
    const commands = await db.commands.list();
    set({ commands });
    return commands.find((c) => c.id === row.id) as Command;
  },

  updateCommand: async (id, data) => {
    // header
    await save('commands.update', () =>
      db.commands.update(id, {
        client_id: data.clientId,
        client_name: data.clientName,
        client_phone: data.clientPhone ?? null,
        receive_date: data.receiveDate || null,
        receive_hour: data.receiveHour,
        receive_minute: data.receiveMinute,
        total_amount: data.totalAmount,
        ...(data.tvaEnabled !== undefined
          ? { tva_enabled: data.tvaEnabled, tva_rate: data.tvaEnabled ? (data.tvaRate ?? 19) : 0 }
          : {}),
        notes: data.notes ?? null,
        // champs facultatifs : ne jamais les effacer sur une mise à jour partielle
        ...(data.clientAddress !== undefined ? { client_address: data.clientAddress || null } : {}),
        ...(data.driverName !== undefined ? { driver_name: data.driverName || null } : {}),
        ...(data.driverPlate !== undefined ? { driver_plate: data.driverPlate || null } : {}),
        ...(data.bonNumber !== undefined ? { bon_number: data.bonNumber || null } : {}),
        ...(data.createdAt ? { created_at: data.createdAt } : {}),
      })
    );
    // Lines are replaced (delete + insert) so they must NOT be touched once a
    // delivery references them — otherwise the delivered quantities would be
    // orphaned and the command would wrongly go back to "non livrée".
    const hasDeliveries = get().deliveries.some((d) => d.commandId === id);
    if (data.items && !hasDeliveries) {
      await save('commands.updateItems', () =>
        db.commands.replaceItems(id, data.items!.map(itemPayload))
      );
    }
    const [commands, deliveries] = await Promise.all([
      db.commands.list(), db.commandDeliveries.list(),
    ]);
    set({ commands, deliveries });
    return !hasDeliveries;
  },

  payDebt: async (commandId, amount, date) => {
    await save('commands.pay', () => rpc.payCommand(commandId, amount, date));
    set({ commands: await db.commands.list() });
  },

  updateStatus: async (commandId, status) => {
    await save('commands.status', () => rpc.setCommandStatus(commandId, status));
    set({ commands: await db.commands.list() });
  },

  deleteCommand: async (id) => {
    const hadDeliveries = get().deliveries.some((d) => d.commandId === id);
    await save('commands.delete', () => db.commands.remove(id));
    set({
      commands: get().commands.filter((c) => c.id !== id),
      deliveries: get().deliveries.filter((d) => d.commandId !== id),
    });
    // ses livraisons partent en cascade : leurs matières reviennent au stock
    if (hadDeliveries) await Promise.all([reloadStock(), reloadSales()]);
  },

  addDelivery: async (commandId, items, deliveredAt, notes = '', driver, payment) => {
    const row = await save('commands.deliver', () =>
      rpc.createCommandDelivery({
        command_id: commandId,
        delivered_at: deliveredAt,
        notes,
        driver_name: driver?.driverName ?? null,
        driver_plate: driver?.driverPlate ?? null,
        location: driver?.location ?? null,
        ...tvaPayload(payment),
        cash_paid: payment?.cashPaid ?? 0,
        advance_applied: payment?.advanceApplied ?? 0,
        items: items.map(deliveryItemPayload),
      })
    );
    // La livraison a retiré les matières premières du stock : « Gestion de
    // stock » doit repartir des quantités réelles de la base.
    const [commands, deliveries] = await Promise.all([
      db.commands.list(), db.commandDeliveries.list(), reloadStock(), reloadSales(),
    ]);
    set({ commands, deliveries });
    return deliveries.find((d) => d.id === row.id) as CommandDelivery;
  },

  updateDelivery: async (id, items, deliveredAt, notes = '', driver, payment) => {
    await save('commands.delivery.update', () =>
      rpc.updateCommandDelivery(id, {
        delivered_at: deliveredAt,
        notes,
        driver_name: driver?.driverName ?? null,
        driver_plate: driver?.driverPlate ?? null,
        location: driver?.location ?? null,
        ...tvaPayload(payment),
        cash_paid: payment?.cashPaid ?? 0,
        advance_applied: payment?.advanceApplied ?? 0,
        items: items.map(deliveryItemPayload),
      })
    );
    // les quantités déduites ont été recalculées côté serveur
    const [commands, deliveries] = await Promise.all([
      db.commands.list(), db.commandDeliveries.list(), reloadStock(), reloadSales(),
    ]);
    set({ commands, deliveries });
  },

  deleteDelivery: async (id) => {
    await save('commands.delivery.delete', () => rpc.deleteCommandDelivery(id));
    // supprimer une livraison remet les matières en stock
    const [commands, deliveries] = await Promise.all([
      db.commands.list(), db.commandDeliveries.list(), reloadStock(), reloadSales(),
    ]);
    set({ commands, deliveries });
  },
}));
