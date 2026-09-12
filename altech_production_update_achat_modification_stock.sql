-- ============================================================================
--  ALTECH PRODUCTION — CIMENT BLIDA
--  CORRECTIF — « Modifier » une facture d'achat n'enregistrait pas les
--  modifications, et le stock ne suivait pas.
-- ----------------------------------------------------------------------------
--  À exécuter APRÈS :
--    1. altech_production_supabase.sql
--    2. altech_production_update_2026.sql
--    3. altech_production_update_achat_bon_matricule.sql
--    4. altech_production_update_pos_production_rapports.sql
--    5. altech_production_update_anciens_achats_ventes_tva.sql
--    6. altech_production_update_achat_modification_complete.sql
--  (Supabase Studio > SQL Editor > coller TOUT le fichier > Run)
--  Le script est idempotent : il peut être relancé sans risque.
-- ----------------------------------------------------------------------------
--  LE BUG
--   La version précédente de update_purchase() corrigeait le stock en DEUX
--   temps : elle retirait d'abord la TOTALITÉ des anciennes quantités, puis
--   réinjectait les nouvelles.
--
--   Or la table products porte la contrainte
--       constraint products_qty_positive check (current_quantity >= 0)
--
--   Dès que la marchandise achetée avait déjà été vendue, consommée en
--   production, envoyée au comptoir ou détruite, le stock actuel était
--   inférieur à la quantité facturée : le retrait intermédiaire le rendait
--   NÉGATIF, la contrainte sautait et TOUTE la transaction était annulée.
--   Résultat côté écran : « Modifier » ne gardait AUCUNE modification —
--   ni le fournisseur, ni la date, ni les lignes, ni le règlement.
--
--   Exemple : 100 sacs achetés, 90 déjà vendus (stock = 10). L'utilisateur
--   corrige la quantité de la facture 100 -> 120.
--     · avant : 10 - 100 = -90  -> CHECK violée -> rien n'est enregistré ;
--     · après : écart = +20     -> 10 + 20 = 30 -> enregistré.
--
--  LE CORRECTIF
--   Le stock est réconcilié PAR ÉCART (nouvelle quantité − ancienne quantité),
--   produit par produit, en une seule écriture. Aucun creux intermédiaire,
--   donc plus aucune violation de contrainte. Les tables liées suivent :
--     · products            — quantités réconciliées par écart, plus la fiche
--                             produit (prix d'achat, seuil d'alerte, unité,
--                             péremption) alignée sur les lignes corrigées ;
--     · stock_movements     — une écriture 'purchase_edit' par produit touché ;
--     · purchase_lines      — remplacées à l'identique de la saisie ;
--     · purchase_payments   — reconstruits UNIQUEMENT si le montant payé
--                             change (l'historique des versements et les
--                             écritures de caisse sont sinon préservés) ;
--     · caisse_transactions — le décaissement suit le nouveau règlement ;
--     · purchases           — fournisseur, date, bon, matricule, ancien achat,
--                             total, payé et reste.
-- ============================================================================

begin;

-- Colonnes utilisées par la fonction — garde-fous si un script antérieur
-- n'a pas été exécuté.
alter table public.purchases
  add column if not exists bon_number    text,
  add column if not exists driver_plate  text,
  add column if not exists is_historical boolean not null default false;


-- ============================================================================
-- 01. trg_purchase_line_to_stock() — silencieux pendant une réconciliation
-- ----------------------------------------------------------------------------
--  update_purchase() calcule lui-même l'écart de stock : quand il réécrit les
--  lignes, le déclencheur ne doit PAS réalimenter les produits, sinon les
--  quantités seraient comptées deux fois. Le drapeau est posé avec
--  set_config(..., true) : il est local à la transaction et disparaît tout
--  seul, même en cas d'erreur.
-- ============================================================================

create or replace function public.trg_purchase_line_to_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_left numeric;
  v_hist boolean;
begin
  if new.product_id is null then
    return new;
  end if;

  -- Réécriture des lignes par update_purchase() : le stock est déjà réconcilié.
  if coalesce(current_setting('altech.skip_purchase_stock', true), '') = '1' then
    return new;
  end if;

  -- « Ancien achat » : la marchandise a été reçue et consommée dans le passé,
  -- le stock d'aujourd'hui ne doit surtout pas être gonflé.
  select coalesce(is_historical, false) into v_hist
    from public.purchases where id = new.purchase_id;
  if coalesce(v_hist, false) then
    return new;
  end if;

  update public.products
     set current_quantity   = current_quantity + new.quantity,
         principal_quantity = principal_quantity + new.quantity,
         min_alert_quantity = coalesce(new.min_alert_quantity, min_alert_quantity),
         purchase_price     = case when new.purchase_price > 0 then new.purchase_price else purchase_price end,
         expiration_date    = coalesce(new.expiration_date, expiration_date),
         expiration_enabled = case when new.expiration_date is not null then true else expiration_enabled end,
         unit_enabled       = case when new.unit_enabled then true else unit_enabled end,
         unit               = case when new.unit_enabled then coalesce(new.unit, unit) else unit end,
         updated_at         = now()
   where id = new.product_id
  returning current_quantity into v_left;

  insert into public.stock_movements (product_id, quantity, reason, ref_table, ref_id, balance_after)
  values (new.product_id, new.quantity, 'purchase', 'purchase_lines', new.id, v_left);

  return new;
end;
$fn$;

drop trigger if exists trg_purchase_line_stock on public.purchase_lines;
create trigger trg_purchase_line_stock
  after insert on public.purchase_lines
  for each row execute function public.trg_purchase_line_to_stock();


-- ============================================================================
-- 02. RPC update_purchase() — modification complète, stock réconcilié par écart
-- ----------------------------------------------------------------------------
--  p_payload :
--    { supplier_id, date, bon_number, driver_plate, is_historical, note,
--      paid_amount, products: [ { product_id, product_name, quantity,
--      purchase_price, min_alert_quantity, unit_enabled, unit,
--      expiration_enabled, expiration_date } ] }
--
--  · Les clés absentes gardent leur valeur actuelle.
--  · `products` absent  -> lignes et stock intacts (modification d'en-tête).
--  · `products` présent -> lignes remplacées et stock réconcilié par écart.
--  · « Ancien achat » : ne mouvemente jamais le stock. Basculer une facture
--    normale en ancien achat retire donc ses quantités, et l'inverse les
--    ajoute — l'écart gère les deux sens automatiquement.
-- ============================================================================

create or replace function public.update_purchase(p_id uuid, p_payload jsonb)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pur      public.purchases;
  v_old_hist boolean;
  v_new_hist boolean;
  v_date     date;
  v_total    numeric;
  v_paid     numeric;
  v_paid_now numeric;
  v_replace  boolean;
  v_line     jsonb;
  v_delta    record;
  v_left     numeric;
begin
  select * into v_pur from public.purchases where id = p_id;
  if v_pur.id is null then
    raise exception 'Facture d achat introuvable (%)', p_id;
  end if;

  v_old_hist := coalesce(v_pur.is_historical, false);
  v_new_hist := coalesce((p_payload ->> 'is_historical')::boolean, v_old_hist);
  v_date     := coalesce(nullif(p_payload ->> 'date', '')::date, v_pur.date);
  v_replace  := jsonb_typeof(p_payload -> 'products') = 'array';

  -- ------------------------------------------------------------------ 1/6
  -- En-tête. Mis à jour d'abord : le reste de la fonction (et le déclencheur
  -- de stock) lit `is_historical` sur la facture.
  update public.purchases
     set supplier_id   = coalesce(nullif(p_payload ->> 'supplier_id', '')::uuid, supplier_id),
         date          = v_date,
         bon_number    = nullif(btrim(coalesce(p_payload ->> 'bon_number', coalesce(bon_number, ''))), ''),
         driver_plate  = nullif(upper(btrim(coalesce(p_payload ->> 'driver_plate', coalesce(driver_plate, '')))), ''),
         is_historical = v_new_hist,
         note          = coalesce(p_payload ->> 'note', note),
         updated_at    = now()
   where id = p_id;

  if v_replace then
    -- ---------------------------------------------------------------- 2/6
    -- Stock réconcilié PAR ÉCART, produit par produit, en une seule écriture.
    --   écart = quantité nouvelle version − quantité ancienne version
    -- Un produit retiré de la facture donne un écart négatif, un produit
    -- ajouté un écart positif. Un « ancien achat » compte pour zéro des deux
    -- côtés puisqu'il n'alimente jamais le stock.
    for v_delta in
      with old_q as (
        select product_id, sum(quantity) as qty
          from public.purchase_lines
         where purchase_id = p_id and product_id is not null
         group by product_id
      ),
      new_q as (
        select (l ->> 'product_id')::uuid as product_id,
               sum(coalesce((l ->> 'quantity')::numeric, 0)) as qty
          from jsonb_array_elements(p_payload -> 'products') as l
         where nullif(l ->> 'product_id', '') is not null
         group by 1
      )
      select coalesce(n.product_id, o.product_id) as product_id,
             (case when v_new_hist then 0 else coalesce(n.qty, 0) end)
           - (case when v_old_hist then 0 else coalesce(o.qty, 0) end) as delta
        from old_q o
        full outer join new_q n on n.product_id = o.product_id
    loop
      continue when coalesce(v_delta.delta, 0) = 0;

      -- greatest(0, ...) : la marchandise a pu être vendue entre-temps.
      -- Le stock ne descend jamais sous zéro (contrainte products_qty_positive)
      -- et la correction reste tracée dans stock_movements.
      update public.products
         set current_quantity   = greatest(0, current_quantity   + v_delta.delta),
             principal_quantity = greatest(0, principal_quantity + v_delta.delta),
             updated_at         = now()
       where id = v_delta.product_id
      returning current_quantity into v_left;

      if v_left is not null then
        insert into public.stock_movements
          (product_id, quantity, reason, ref_table, ref_id, balance_after)
        values (v_delta.product_id, v_delta.delta, 'purchase_edit',
                'purchases', p_id, v_left);
      end if;
    end loop;

    -- ---------------------------------------------------------------- 3/6
    -- Lignes remplacées, déclencheur de stock muet (écart déjà appliqué).
    perform set_config('altech.skip_purchase_stock', '1', true);

    delete from public.purchase_lines where purchase_id = p_id;

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

    perform set_config('altech.skip_purchase_stock', '0', true);

    -- ---------------------------------------------------------------- 4/6
    -- Fiche produit (/stock) alignée sur la facture corrigée, exactement comme
    -- à la création : prix d'achat, seuil d'alerte, unité et péremption.
    -- Un ancien achat ne touche pas à la fiche du jour.
    if not v_new_hist then
      for v_line in select * from jsonb_array_elements(p_payload -> 'products') loop
        continue when nullif(v_line ->> 'product_id', '') is null;

        update public.products
           set min_alert_quantity = coalesce(nullif(v_line ->> 'min_alert_quantity', '')::numeric,
                                             min_alert_quantity),
               purchase_price     = case when coalesce((v_line ->> 'purchase_price')::numeric, 0) > 0
                                         then (v_line ->> 'purchase_price')::numeric
                                         else purchase_price end,
               expiration_date    = coalesce(nullif(v_line ->> 'expiration_date', '')::date, expiration_date),
               expiration_enabled = case when nullif(v_line ->> 'expiration_date', '') is not null
                                         then true else expiration_enabled end,
               unit_enabled       = case when coalesce((v_line ->> 'unit_enabled')::boolean, false)
                                         then true else unit_enabled end,
               unit               = case when coalesce((v_line ->> 'unit_enabled')::boolean, false)
                                         then coalesce(v_line ->> 'unit', unit) else unit end,
               updated_at         = now()
         where id = (v_line ->> 'product_id')::uuid;
      end loop;
    end if;
  end if;

  -- ------------------------------------------------------------------ 5/6
  -- Total recalculé sur les lignes réellement enregistrées.
  select sum(quantity * purchase_price) into v_total
    from public.purchase_lines where purchase_id = p_id;
  if v_total is null then
    v_total := case when v_replace then 0 else v_pur.total_amount end;
  end if;

  v_paid := least(
    greatest(0, coalesce((p_payload ->> 'paid_amount')::numeric, v_pur.paid_amount)),
    v_total);

  -- ------------------------------------------------------------------ 6/6
  -- Règlement reconstruit UNIQUEMENT s'il a changé : sinon les versements
  -- successifs saisis avec le bouton « Payer » et leurs écritures de caisse
  -- seraient écrasés par un versement unique. La suppression retire le
  -- décaissement (trg_purchase_payments_caisse_del), l'insertion en recrée un
  -- — sauf pour un ancien achat, réglé hors du logiciel.
  select coalesce(sum(amount), 0) into v_paid_now
    from public.purchase_payments where purchase_id = p_id;

  if round(v_paid, 2) <> round(v_paid_now, 2) then
    delete from public.purchase_payments where purchase_id = p_id;
    if v_paid > 0 then
      insert into public.purchase_payments (purchase_id, date, amount, description)
      values (p_id, v_date, v_paid,
              case when v_new_hist then 'Reglement ancien achat (modifie)'
                   else 'Reglement achat (modifie)' end);
    end if;
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
-- 03. CONTRÔLE — écarts de stock générés par la modification d'un achat
-- ============================================================================

-- Les colonnes changent de nom (quantity -> ecart) : « create or replace »
-- refuserait, la vue est donc reconstruite.
drop view if exists public.v_purchase_stock_corrections;

create view public.v_purchase_stock_corrections as
select m.created_at,
       m.product_id,
       p.name          as product_name,
       m.quantity      as ecart,
       m.balance_after as stock_apres,
       m.ref_id        as purchase_id,
       pu.reference    as purchase_reference
  from public.stock_movements m
  left join public.products  p  on p.id  = m.product_id
  left join public.purchases pu on pu.id = m.ref_id
 where m.reason = 'purchase_edit'
 order by m.created_at desc;

grant select on public.v_purchase_stock_corrections to authenticated, service_role;

commit;
