-- ============================================================================
--  ALTECH PRODUCTION — CIMENT BLIDA
--  MISE À JOUR — MODIFICATION COMPLÈTE D'UNE FACTURE D'ACHAT
-- ----------------------------------------------------------------------------
--  À exécuter APRÈS :
--    1. altech_production_supabase.sql
--    2. altech_production_update_2026.sql
--    3. altech_production_update_achat_bon_matricule.sql
--    4. altech_production_update_pos_production_rapports.sql
--    5. altech_production_update_anciens_achats_ventes_tva.sql
--  (Supabase Studio > SQL Editor > coller TOUT le fichier > Run)
--  Le script est idempotent : il peut être relancé sans risque.
-- ----------------------------------------------------------------------------
--  POURQUOI
--   Le bouton « Modifier » d'une facture d'achat n'autorisait que l'en-tête
--   (date, n° de bon, matricule, montant payé). L'utilisateur doit pouvoir
--   rouvrir la facture EXACTEMENT comme à sa création et corriger TOUT :
--   fournisseur, date, bon de livraison, matricule, lignes de marchandises
--   (produit, quantité, prix, seuil d'alerte, unité, péremption) et règlement.
--
--   Toutes les tables liées suivent la correction :
--     · products            — le stock des anciennes lignes est REPRIS puis les
--                             nouvelles quantités sont réinjectées ;
--     · stock_movements     — une écriture d'annulation puis les nouvelles ;
--     · purchase_lines      — remplacées à l'identique de la saisie ;
--     · purchase_payments   — reconstruits sur le nouveau montant payé ;
--     · caisse_transactions — le décaissement suit le nouveau règlement ;
--     · purchases           — total, payé et reste recalculés.
-- ============================================================================

alter table public.purchases
  add column if not exists is_historical boolean not null default false;


-- ============================================================================
-- 01. RPC update_purchase() — modification COMPLÈTE d'une facture d'achat
-- ----------------------------------------------------------------------------
--  p_payload :
--    { supplier_id, date, bon_number, driver_plate, is_historical, note,
--      paid_amount, products: [ { product_id, product_name, quantity,
--      purchase_price, min_alert_quantity, unit_enabled, unit,
--      expiration_enabled, expiration_date } ] }
--
--  · Les clés absentes gardent leur valeur actuelle : l'ancien écran
--    « en-tête seul » continue donc de fonctionner sans changement.
--  · `products` absent  -> les lignes et le stock ne sont pas touchés.
--  · `products` présent -> le stock de l'ancienne facture est annulé puis
--    réappliqué avec les nouvelles lignes (sauf « ancien achat », qui ne
--    mouvemente jamais le stock).
-- ============================================================================

create or replace function public.update_purchase(p_id uuid, p_payload jsonb)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pur       public.purchases;
  v_old_hist  boolean;
  v_new_hist  boolean;
  v_date      date;
  v_total     numeric;
  v_paid      numeric;
  v_line      jsonb;
  v_old       record;
  v_left      numeric;
  v_replace   boolean;
begin
  select * into v_pur from public.purchases where id = p_id;
  if v_pur.id is null then
    raise exception 'Facture d achat introuvable (%)', p_id;
  end if;

  v_old_hist := coalesce(v_pur.is_historical, false);
  v_new_hist := coalesce((p_payload ->> 'is_historical')::boolean, v_old_hist);
  v_date     := coalesce(nullif(p_payload ->> 'date', '')::date, v_pur.date);
  v_replace  := jsonb_typeof(p_payload -> 'products') = 'array';

  -- ------------------------------------------------------------------ 1/5
  -- Reprise du stock alimenté par l'ancienne version de la facture.
  -- Un « ancien achat » n'a jamais rien ajouté : il n'y a rien à reprendre.
  if v_replace and not v_old_hist then
    for v_old in
      select id, product_id, quantity
        from public.purchase_lines
       where purchase_id = p_id and product_id is not null
    loop
      update public.products
         set current_quantity   = current_quantity   - v_old.quantity,
             principal_quantity = principal_quantity - v_old.quantity,
             updated_at         = now()
       where id = v_old.product_id
      returning current_quantity into v_left;

      if v_left is not null then
        insert into public.stock_movements
          (product_id, quantity, reason, ref_table, ref_id, balance_after)
        values (v_old.product_id, -v_old.quantity, 'purchase_edit',
                'purchase_lines', v_old.id, v_left);
      end if;
    end loop;
  end if;

  if v_replace then
    delete from public.purchase_lines where purchase_id = p_id;
  end if;

  -- ------------------------------------------------------------------ 2/5
  -- En-tête mis à jour AVANT les nouvelles lignes : le déclencheur de stock
  -- lit `is_historical` sur la facture pour savoir s'il doit alimenter.
  update public.purchases
     set supplier_id   = coalesce(nullif(p_payload ->> 'supplier_id', '')::uuid, supplier_id),
         date          = v_date,
         bon_number    = nullif(btrim(coalesce(p_payload ->> 'bon_number', coalesce(bon_number, ''))), ''),
         driver_plate  = nullif(upper(btrim(coalesce(p_payload ->> 'driver_plate', coalesce(driver_plate, '')))), ''),
         is_historical = v_new_hist,
         note          = coalesce(p_payload ->> 'note', note),
         updated_at    = now()
   where id = p_id;

  -- ------------------------------------------------------------------ 3/5
  -- Nouvelles lignes : trg_purchase_line_stock réalimente products et
  -- stock_movements (sauf ancien achat).
  if v_replace then
    for v_line in select * from jsonb_array_elements(p_payload -> 'products') loop
      insert into public.purchase_lines (
        purchase_id, product_id, product_name, quantity, purchase_price,
        min_alert_quantity, unit_enabled, unit, expiration_enabled, expiration_date)
      values (
        p_id,
        nullif(v_line ->> 'product_id', '')::uuid,
        coalesce(v_line ->> 'product_name', 'Produit'),
        coalesce((v_line ->> 'quantity')::numeric, 0),
        coalesce((v_line ->> 'purchase_price')::numeric, 0),
        nullif(v_line ->> 'min_alert_quantity', '')::numeric,
        coalesce((v_line ->> 'unit_enabled')::boolean, false),
        v_line ->> 'unit',
        coalesce((v_line ->> 'expiration_enabled')::boolean, false),
        nullif(v_line ->> 'expiration_date', '')::date
      );
    end loop;
  end if;

  -- ------------------------------------------------------------------ 4/5
  -- Total recalculé sur les lignes réellement enregistrées.
  v_total := coalesce(
    (select sum(quantity * purchase_price) from public.purchase_lines where purchase_id = p_id), 0);
  v_paid  := least(
    greatest(0, coalesce((p_payload ->> 'paid_amount')::numeric, v_pur.paid_amount)),
    v_total);

  -- ------------------------------------------------------------------ 5/5
  -- Règlement reconstruit : la suppression retire le décaissement de caisse
  -- (trg_purchase_payments_caisse_del), l'insertion en recrée un — sauf pour
  -- un ancien achat, réglé hors du logiciel.
  delete from public.purchase_payments where purchase_id = p_id;
  if v_paid > 0 then
    insert into public.purchase_payments (purchase_id, date, amount, description)
    values (p_id, v_date, v_paid,
            case when v_new_hist then 'Reglement ancien achat (modifie)'
                 else 'Reglement achat (modifie)' end);
  end if;

  update public.purchases
     set total_amount = v_total,
         paid_amount  = v_paid,
         rest_amount  = greatest(0, v_total - v_paid),
         updated_at   = now()
   where id = p_id
  returning * into v_pur;

  perform public.log_activity('purchase', 'update', 'purchases', p_id, p_payload);
  return v_pur;
end;
$fn$;

grant execute on function public.update_purchase(uuid, jsonb) to authenticated, service_role;


-- ============================================================================
-- 02. CONTRÔLE — reprises de stock générées par la modification d'un achat
-- ============================================================================

create or replace view public.v_purchase_stock_corrections as
select m.created_at,
       m.product_id,
       p.name as product_name,
       m.quantity,
       m.balance_after
  from public.stock_movements m
  left join public.products p on p.id = m.product_id
 where m.reason = 'purchase_edit'
 order by m.created_at desc;

grant select on public.v_purchase_stock_corrections to authenticated, service_role;
