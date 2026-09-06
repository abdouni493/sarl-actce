-- ============================================================================
--  ALTECH PRODUCTION — MISE A JOUR
--  « LA LIVRAISON EST UNE VENTE + TVA COMMANDE/LIVRAISON + EN-TETE SOCIETE »
-- ----------------------------------------------------------------------------
--  A executer EN UNE SEULE FOIS dans Supabase -> SQL Editor.
--  Le script est idempotent : il peut etre relance sans risque.
--
--  CE QUE CE SCRIPT AJOUTE
--  -----------------------
--    1. LA LIVRAISON D'UNE COMMANDE DEVIENT UNE VENTE
--       Chaque bon de livraison genere (et tient a jour) une facture de vente
--       dans `sales` :
--         · elle se comporte exactement comme une vente encaissee a la caisse
--           (ecran /ventes : voir, modifier, supprimer, imprimer, payer),
--         · l'operateur saisit CE QUE LE CLIENT PAIE au moment de la remise,
--           le reste devient automatiquement une DETTE CLIENT,
--         · l'acompte deja verse sur la commande peut etre impute sur la
--           livraison SANS reecrire la caisse (il y est deja entre),
--         · la vente apparait dans l'historique du client, dans les
--           transactions de caisse et dans les rapports.
--
--    2. TVA SUR LA COMMANDE ET SUR LA LIVRAISON
--       commands.tva_enabled / tva_rate / tva_amount / total_ttc
--       command_deliveries.tva_enabled / tva_rate / tva_amount
--       -> activable ou desactivable a la creation comme a la modification ;
--          les documents imprimes n'affichent la TVA que si elle est active.
--
--    3. PAIEMENTS DE VENTE TRACES ET « HORS CAISSE »
--       sale_payments.skip_caisse : une imputation d'acompte ne cree aucune
--       ecriture de caisse (l'argent est deja dans le tiroir).
--       sale_payments.origin      : distingue les reglements generes par la
--       livraison des reglements de dette saisis ensuite.
--
--    4. EN-TETE DES DOCUMENTS IMPRIMES
--       store_settings.activity_place (LIEU D'ACTIVITE) et store_settings.city
--       (« BLIDA LE ... »), repris par tous les modeles d'impression.
--
--  CONTENU
--  -------
--    01. store_settings — lieu d'activite + ville
--    02. sale_payments  — skip_caisse / origin (+ declencheur de caisse)
--    03. sales          — delivery_id / command_id (+ colonnes de securite)
--    04. commands       — TVA, total TTC, extra_paid (+ declencheur de totaux)
--    05. command_deliveries — TVA, valeurs, encaissement, vente liee
--    06. recompute_command_payments()  — acompte + reglements + livraisons
--    07. apply_delivery_sale()         — cree / met a jour la vente du bon
--    08. create_command()              — TVA de la commande
--    09. pay_command()                 — regle sur le TTC
--    10. create_command_delivery()     — livraison encaissee = vente
--    11. update_command_delivery()     — idem en modification
--    12. delete_command_delivery()     — supprime la vente liee
--    13. update_sale() / pay_sale_debt() — pilotent le bon de livraison
--    14. Supprimer la vente d'une livraison supprime le bon
--    15. Reprise des livraisons deja saisies
--    16. Vues de controle + droits
-- ============================================================================

begin;


-- ============================================================================
-- 01. STORE_SETTINGS — lieu d'activite et ville (en-tete des documents)
-- ============================================================================

alter table public.store_settings
  add column if not exists activity_place text,
  add column if not exists city           text;

comment on column public.store_settings.activity_place is
  'Lieu d''activite imprime sous la raison sociale (ex : BAHLI BLIDA).';
comment on column public.store_settings.city is
  'Ville utilisee par la mention « <VILLE> LE jj/mm/aaaa » des documents.';


-- ============================================================================
-- 02. SALE_PAYMENTS — origine du reglement et ecriture de caisse facultative
-- ----------------------------------------------------------------------------
--  Quand l'acompte deja verse sur une commande est impute sur la livraison,
--  l'argent est deja entre en caisse le jour de la commande : le rejouer
--  gonflerait le tiroir. `skip_caisse` neutralise l'ecriture.
--  `origin` permet a apply_delivery_sale() de reconstruire SES deux lignes
--  (acompte impute + encaissement du jour) sans effacer les reglements de
--  dette saisis plus tard, qui ont leur propre date en caisse.
-- ============================================================================

alter table public.sale_payments
  add column if not exists skip_caisse boolean not null default false,
  add column if not exists origin      text;

comment on column public.sale_payments.skip_caisse is
  'Reglement deja encaisse ailleurs (acompte de commande impute sur une livraison) : aucune ecriture de caisse.';
comment on column public.sale_payments.origin is
  'delivery_advance = acompte de commande impute ; delivery_cash = encaissement du bon ; NULL = reglement libre.';

create index if not exists sale_payments_origin_idx
  on public.sale_payments (sale_id, origin);

create or replace function public.trg_sale_payment_to_caisse()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ref  text;
  v_hist boolean;
begin
  -- imputation d'un acompte deja encaisse : rien a ecrire
  if coalesce(new.skip_caisse, false) then
    return new;
  end if;

  select reference, coalesce(is_historical, false)
    into v_ref, v_hist
    from public.sales where id = new.sale_id;

  -- l'argent d'une ancienne vente a ete encaisse dans le passe, hors logiciel
  if coalesce(v_hist, false) then
    return new;
  end if;

  insert into public.caisse_transactions (type, amount, date, description, category_name, ref_table, ref_id, created_by)
  values ('deposit', new.amount, new.date,
          coalesce(new.description, 'Paiement vente') || ' ' || coalesce(v_ref, ''),
          'Vente', 'sale_payments', new.id, new.created_by)
  on conflict (ref_table, ref_id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists trg_sale_payment_caisse on public.sale_payments;
create trigger trg_sale_payment_caisse
  after insert on public.sale_payments
  for each row execute function public.trg_sale_payment_to_caisse();


-- ============================================================================
-- 03. SALES — rattachement au bon de livraison et a la commande
-- ----------------------------------------------------------------------------
--  `delivery_id` : la vente EST le bon de livraison. Supprimer le bon supprime
--  la vente (cascade) ; supprimer la vente supprime le bon (section 14).
--  Les colonnes de facturation sont (re)creees par securite : le script reste
--  executable meme si une mise a jour precedente a ete sautee.
-- ============================================================================

alter table public.sales
  add column if not exists bon_number    text,
  add column if not exists is_historical boolean       not null default false,
  add column if not exists tva_enabled   boolean       not null default false,
  add column if not exists tva_rate      numeric(6,2)  not null default 0,
  add column if not exists tva_amount    numeric(14,2) not null default 0,
  add column if not exists delivery_id   uuid,
  add column if not exists command_id    uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_delivery_id_fkey') then
    alter table public.sales
      add constraint sales_delivery_id_fkey
      foreign key (delivery_id) references public.command_deliveries(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_command_id_fkey') then
    alter table public.sales
      add constraint sales_command_id_fkey
      foreign key (command_id) references public.commands(id) on delete set null;
  end if;
end $$;

create unique index if not exists sales_delivery_uidx
  on public.sales (delivery_id) where delivery_id is not null;
create index if not exists sales_command_idx
  on public.sales (command_id) where command_id is not null;

comment on column public.sales.delivery_id is
  'Bon de livraison a l''origine de cette facture de vente (la livraison EST la vente).';
comment on column public.sales.command_id is
  'Commande client a l''origine de la livraison facturee.';


-- ============================================================================
-- 04. COMMANDS — TVA, total TTC et reglements complementaires
-- ----------------------------------------------------------------------------
--  `total_amount` reste le total HORS TAXES des lignes ; `total_ttc` est le net
--  a payer. Le reste du a une commande se calcule TOUJOURS sur le TTC.
--
--  `advance_paid`  : acompte verse a la creation de la commande.
--  `extra_paid`    : reglements encaisses depuis l'ecran « Commandes ».
--  `paid_amount`   : advance_paid + extra_paid + encaissements des livraisons.
-- ============================================================================

alter table public.commands
  add column if not exists tva_enabled boolean       not null default false,
  add column if not exists tva_rate    numeric(6,2)  not null default 0,
  add column if not exists tva_amount  numeric(14,2) not null default 0,
  add column if not exists total_ttc   numeric(14,2) not null default 0,
  add column if not exists extra_paid  numeric(14,2) not null default 0;

-- reprise des commandes existantes : pas de TVA, TTC = HT, reglements = paye - acompte
update public.commands
   set total_ttc = total_amount
 where coalesce(total_ttc, 0) = 0 and coalesce(total_amount, 0) <> 0;

update public.commands
   set extra_paid = greatest(0, coalesce(paid_amount, 0) - coalesce(advance_paid, 0))
 where coalesce(extra_paid, 0) = 0
   and coalesce(paid_amount, 0) > coalesce(advance_paid, 0);

comment on column public.commands.tva_enabled is
  'TVA activee sur la commande — reprise par defaut sur chaque livraison et sur les documents imprimes.';
comment on column public.commands.total_ttc is
  'Net a payer de la commande : total HT + TVA. C''est lui qui determine le reste du.';
comment on column public.commands.extra_paid is
  'Reglements encaisses depuis l''ecran Commandes (hors acompte initial et hors livraisons).';

/**
 * Totaux d'une commande : la TVA, le TTC et le reste du sont TOUJOURS
 * recalcules, que la commande soit ecrite par une RPC ou modifiee ligne a
 * ligne depuis l'ecran d'edition.
 */
create or replace function public.trg_command_totals()
returns trigger
language plpgsql
as $fn$
begin
  if coalesce(new.tva_enabled, false) then
    if coalesce(new.tva_rate, 0) <= 0 then new.tva_rate := 19; end if;
  else
    new.tva_rate := 0;
  end if;
  new.tva_amount  := round(coalesce(new.total_amount, 0) * coalesce(new.tva_rate, 0) / 100, 2);
  new.total_ttc   := coalesce(new.total_amount, 0) + new.tva_amount;
  new.paid_amount := greatest(0, coalesce(new.paid_amount, 0));
  new.rest_amount := greatest(0, new.total_ttc - new.paid_amount);
  return new;
end;
$fn$;

drop trigger if exists trg_commands_totals on public.commands;
create trigger trg_commands_totals
  before insert or update on public.commands
  for each row execute function public.trg_command_totals();


-- ============================================================================
-- 05. COMMAND_DELIVERIES — TVA, valeur livree, encaissement et vente liee
-- ============================================================================

alter table public.command_deliveries
  add column if not exists tva_enabled     boolean       not null default false,
  add column if not exists tva_rate        numeric(6,2)  not null default 0,
  add column if not exists tva_amount      numeric(14,2) not null default 0,
  add column if not exists total_ht        numeric(14,2) not null default 0,
  add column if not exists total_ttc       numeric(14,2) not null default 0,
  add column if not exists advance_applied numeric(14,2) not null default 0,
  add column if not exists cash_paid       numeric(14,2) not null default 0,
  add column if not exists paid_amount     numeric(14,2) not null default 0,
  add column if not exists rest_amount     numeric(14,2) not null default 0,
  add column if not exists sale_id         uuid,
  add column if not exists sale_reference  text;

comment on column public.command_deliveries.total_ht is
  'Valeur hors taxes de la marchandise remise sur ce bon (quantites livrees x P.U. de la commande).';
comment on column public.command_deliveries.advance_applied is
  'Part de l''acompte de la commande imputee sur cette livraison — aucune ecriture de caisse.';
comment on column public.command_deliveries.cash_paid is
  'Argent REELLEMENT encaisse au moment de la remise — entre en caisse.';
comment on column public.command_deliveries.paid_amount is
  'Total credite a la livraison : acompte impute + encaissements (remise + reglements de dette).';
comment on column public.command_deliveries.sale_id is
  'Facture de vente generee par ce bon de livraison.';

create index if not exists command_deliveries_sale_idx
  on public.command_deliveries (sale_id) where sale_id is not null;


-- ============================================================================
-- 06. recompute_command_payments() — ce que le client a verse sur la commande
-- ----------------------------------------------------------------------------
--  paid_amount = acompte initial
--              + reglements encaisses depuis l'ecran « Commandes »
--              + argent REELLEMENT recu par les livraisons
--                (paye de la facture - acompte deja impute dessus).
--  Le declencheur de la section 04 recalcule ensuite le reste du sur le TTC.
-- ============================================================================

create or replace function public.recompute_command_payments(p_command_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.commands c
     set paid_amount = coalesce(c.advance_paid, 0)
                     + coalesce(c.extra_paid, 0)
                     + coalesce((
                         select sum(greatest(0, coalesce(s.paid_amount, d.paid_amount, 0)
                                              - coalesce(d.advance_applied, 0)))
                           from public.command_deliveries d
                           left join public.sales s on s.delivery_id = d.id
                          where d.command_id = c.id), 0),
         updated_at  = now()
   where c.id = p_command_id;
end;
$fn$;

/** Acompte de la commande encore disponible pour etre impute sur un bon. */
create or replace function public.command_advance_available(
  p_command_id uuid, p_exclude_delivery uuid default null
) returns numeric
language sql
stable
security definer
set search_path = public
as $fn$
  select greatest(0,
           coalesce((select c.advance_paid + c.extra_paid from public.commands c
                      where c.id = p_command_id), 0)
         - coalesce((select sum(d.advance_applied) from public.command_deliveries d
                      where d.command_id = p_command_id
                        and (p_exclude_delivery is null or d.id <> p_exclude_delivery)), 0));
$fn$;


-- ============================================================================
-- 07. apply_delivery_sale() — LE BON DE LIVRAISON DEVIENT UNE FACTURE DE VENTE
-- ----------------------------------------------------------------------------
--  Cree la vente si elle n'existe pas encore, la met a jour sinon :
--    · lignes = produits reellement remis, au prix unitaire de la commande,
--    · TVA    = option du bon de livraison,
--    · paye   = acompte impute (hors caisse) + encaissement du jour (caisse)
--               + reglements de dette saisis ensuite (conserves tels quels),
--    · reste  = dette client suivie (carte client, rapports, caisse).
--  AUCUN mouvement de stock ici : les matieres ont deja ete retirees par
--  apply_command_delivery_stock() au moment de la livraison.
-- ============================================================================

create or replace function public.apply_delivery_sale(p_delivery_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_del    public.command_deliveries;
  v_cmd    public.commands;
  v_sale   public.sales;
  v_ht     numeric := 0;
  v_tva    numeric := 0;
  v_ttc    numeric := 0;
  v_adv    numeric;
  v_cash   numeric;
  v_extra  numeric := 0;
  v_paid   numeric;
  v_rest   numeric;
  v_ref    text;
  v_seq    int;
  v_status public.sale_status;
  v_hist   boolean;
  v_year   text;
begin
  select * into v_del from public.command_deliveries where id = p_delivery_id;
  if v_del.id is null then return null; end if;
  select * into v_cmd from public.commands where id = v_del.command_id;
  if v_cmd.id is null then return null; end if;

  v_hist := coalesce(v_del.is_historical, coalesce(v_cmd.is_historical, false));

  -- ---- valeur HORS TAXES de ce qui est remis sur ce bon --------------------
  select coalesce(sum(di.quantity * coalesce(px.unit_price, 0)), 0)
    into v_ht
    from public.command_delivery_items di
    left join lateral (
      select ci.unit_price
        from public.command_items ci
       where ci.command_id = v_del.command_id
         and (ci.id = di.command_item_id
              or (di.command_item_id is null and ci.product_name = di.product_name))
       order by (ci.id = di.command_item_id) desc
       limit 1
    ) px on true
   where di.delivery_id = p_delivery_id;

  v_tva := case when coalesce(v_del.tva_enabled, false)
                then round(v_ht * coalesce(v_del.tva_rate, 0) / 100, 2) else 0 end;
  v_ttc := v_ht + v_tva;

  -- ---- la facture de vente -------------------------------------------------
  select * into v_sale from public.sales where delivery_id = p_delivery_id;

  if v_sale.id is null then
    v_year := to_char(coalesce(v_del.delivered_at, now()), 'YYYY');
    select coalesce(count(*), 0) + 1 into v_seq from public.sales;
    v_ref := 'VNT-' || v_year || '-' || lpad(v_seq::text, 3, '0');
    while exists (select 1 from public.sales where reference = v_ref) loop
      v_seq := v_seq + 1;
      v_ref := 'VNT-' || v_year || '-' || lpad(v_seq::text, 3, '0');
    end loop;

    insert into public.sales (reference, client_id, date, total_amount, reduction, final_amount,
                              paid_amount, rest_amount, status, note, bon_number, is_historical,
                              tva_enabled, tva_rate, tva_amount, delivery_id, command_id,
                              created_by, created_at)
    values (v_ref, v_cmd.client_id, coalesce(v_del.delivered_at, now())::date,
            v_ht, 0, v_ttc, 0, v_ttc, 'debt'::public.sale_status,
            nullif(btrim(coalesce(v_del.notes, '')), ''),
            v_cmd.bon_number, v_hist,
            coalesce(v_del.tva_enabled, false), coalesce(v_del.tva_rate, 0), v_tva,
            p_delivery_id, v_cmd.id,
            coalesce(v_del.created_by, public.current_username()),
            coalesce(v_del.delivered_at, now()))
    returning * into v_sale;
  end if;

  -- ---- ce que le client regle sur cette livraison --------------------------
  --  Les reglements « libres » (dette payee apres coup) gardent leur date et
  --  leur ecriture de caisse : on ne recalcule que les deux lignes du bon.
  select coalesce(sum(amount), 0) into v_extra
    from public.sale_payments
   where sale_id = v_sale.id and coalesce(origin, '') not in ('delivery_advance', 'delivery_cash');

  v_adv  := least(greatest(0, coalesce(v_del.advance_applied, 0)), v_ttc);
  v_cash := least(greatest(0, coalesce(v_del.cash_paid, 0)), greatest(0, v_ttc - v_adv));
  v_extra := least(greatest(0, v_extra), greatest(0, v_ttc - v_adv - v_cash));
  v_paid := v_adv + v_cash + v_extra;
  v_rest := greatest(0, v_ttc - v_paid);
  v_status := case when v_rest <= 0 then 'paid'::public.sale_status
                   else 'debt'::public.sale_status end;

  update public.sales
     set client_id     = v_cmd.client_id,
         date          = coalesce(v_del.delivered_at, now())::date,
         total_amount  = v_ht,
         reduction     = 0,
         final_amount  = v_ttc,
         paid_amount   = v_paid,
         rest_amount   = v_rest,
         status        = v_status,
         note          = nullif(btrim(coalesce(v_del.notes, '')), ''),
         bon_number    = v_cmd.bon_number,
         is_historical = v_hist,
         tva_enabled   = coalesce(v_del.tva_enabled, false),
         tva_rate      = coalesce(v_del.tva_rate, 0),
         tva_amount    = v_tva,
         command_id    = v_cmd.id,
         updated_at    = now()
   where id = v_sale.id
  returning * into v_sale;

  -- ---- lignes de la facture = produits remis -------------------------------
  --  Aucune consommation de stock : elle a deja eu lieu a la livraison.
  --
  --  `fiche_technic_id` n'est recopie QUE si la fiche existe encore : une
  --  commande peut porter la reference d'une fiche technique supprimee depuis,
  --  et `sale_lines.fiche_technic_id` est contraint par une cle etrangere.
  delete from public.sale_lines where sale_id = v_sale.id;
  insert into public.sale_lines (sale_id, product_id, comptoir_id, fiche_technic_id,
                                 product_name, quantity, selling_price, base_price,
                                 sell_by_unit, unit)
  select v_sale.id, null, null,
         (select ft.id from public.fiche_technics ft where ft.id = px.fiche_technic_id),
         di.product_name, di.quantity, coalesce(px.unit_price, 0), coalesce(px.unit_price, 0),
         coalesce(px.sell_by_unit, false), coalesce(di.sell_unit, px.sell_unit)
    from public.command_delivery_items di
    left join lateral (
      select ci.unit_price, ci.fiche_technic_id, ci.sell_by_unit, ci.sell_unit
        from public.command_items ci
       where ci.command_id = v_del.command_id
         and (ci.id = di.command_item_id
              or (di.command_item_id is null and ci.product_name = di.product_name))
       order by (ci.id = di.command_item_id) desc
       limit 1
    ) px on true
   where di.delivery_id = p_delivery_id;

  -- ---- les deux reglements du bon (acompte impute + encaissement) ----------
  delete from public.sale_payments
   where sale_id = v_sale.id and coalesce(origin, '') in ('delivery_advance', 'delivery_cash');
  if v_adv > 0 then
    insert into public.sale_payments (sale_id, date, amount, description, skip_caisse, origin)
    values (v_sale.id, v_sale.date, v_adv,
            'Acompte commande ' || v_cmd.reference || ' impute sur ' || v_del.reference,
            true, 'delivery_advance');
  end if;
  if v_cash > 0 then
    insert into public.sale_payments (sale_id, date, amount, description, skip_caisse, origin)
    values (v_sale.id, v_sale.date, v_cash,
            'Encaissement livraison ' || v_del.reference, false, 'delivery_cash');
  end if;

  -- ---- la dette client suivie ---------------------------------------------
  delete from public.client_debts
   where description = 'Reste livraison ' || v_del.reference
     and coalesce(total_paid, 0) = 0;
  if v_rest > 0 and v_cmd.client_id is not null then
    insert into public.client_debts (client_id, client_name, client_phone, total_debt, rest_amount,
                                     date, description, created_by)
    select v_cmd.client_id, c.name, c.phone, v_rest, v_rest, v_sale.date,
           'Reste livraison ' || v_del.reference, public.current_username()
      from public.clients c where c.id = v_cmd.client_id;
  end if;

  -- ---- le bon de livraison memorise sa situation ---------------------------
  update public.command_deliveries
     set total_ht        = v_ht,
         tva_amount      = v_tva,
         total_ttc       = v_ttc,
         advance_applied = v_adv,
         cash_paid       = v_cash,
         paid_amount     = v_paid,
         rest_amount     = v_rest,
         sale_id         = v_sale.id,
         sale_reference  = v_sale.reference,
         updated_at      = now()
   where id = p_delivery_id;

  -- ---- la commande suit ce que le client a verse ---------------------------
  perform public.recompute_command_payments(v_del.command_id);

  return v_sale.id;
end;
$fn$;


-- ============================================================================
-- 08. create_command() — TVA de la commande
-- ----------------------------------------------------------------------------
--  Reprend la derniere version (adresse, chauffeur, matricule, n° de bon, date
--  de creation editable, ancienne commande) et ajoute l'option TVA. Le
--  declencheur de la section 04 calcule tva_amount / total_ttc / rest_amount.
--  Aucun consume_stock() ici : la matiere ne part qu'a la livraison.
-- ============================================================================

create or replace function public.create_command(p_payload jsonb)
returns public.commands
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cmd      public.commands;
  v_ref      text;
  v_item     jsonb;
  v_total    numeric := 0;
  v_advance  numeric := coalesce((p_payload ->> 'advance_paid')::numeric, 0);
  v_seq      int;
  v_created  timestamptz := coalesce(nullif(p_payload ->> 'created_at', '')::timestamptz, now());
  v_bon      text := nullif(btrim(coalesce(p_payload ->> 'bon_number', '')), '');
  v_addr     text := nullif(btrim(coalesce(p_payload ->> 'client_address', '')), '');
  v_driver   text := nullif(btrim(coalesce(p_payload ->> 'driver_name', '')), '');
  v_plate    text := nullif(btrim(coalesce(p_payload ->> 'driver_plate', '')), '');
  v_client   uuid := nullif(p_payload ->> 'client_id', '')::uuid;
  v_hist     boolean := coalesce((p_payload ->> 'is_historical')::boolean, false);
  v_tva_on   boolean := coalesce((p_payload ->> 'tva_enabled')::boolean, false);
  v_tva_rate numeric := coalesce((p_payload ->> 'tva_rate')::numeric, 19);
  v_year     text := to_char(v_created, 'YYYY');
begin
  select coalesce(count(*), 0) + 1 into v_seq from public.commands;
  v_ref := 'CMD-' || v_year || '-' || lpad(v_seq::text, 3, '0');
  while exists (select 1 from public.commands where reference = v_ref) loop
    v_seq := v_seq + 1;
    v_ref := 'CMD-' || v_year || '-' || lpad(v_seq::text, 3, '0');
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    v_total := v_total + coalesce((v_item ->> 'total_price')::numeric,
                 coalesce((v_item ->> 'quantity')::numeric, 0) * coalesce((v_item ->> 'unit_price')::numeric, 0));
  end loop;
  v_total := coalesce((p_payload ->> 'total_amount')::numeric, v_total);

  if not v_tva_on then v_tva_rate := 0; end if;

  if v_addr is null and v_client is not null then
    select nullif(btrim(address), '') into v_addr from public.clients where id = v_client;
  end if;

  insert into public.commands (reference, client_id, client_name, client_phone, client_address,
                               driver_name, driver_plate, receive_date,
                               receive_hour, receive_minute, total_amount, advance_paid,
                               extra_paid, paid_amount, rest_amount, status, notes, bon_number,
                               is_historical, tva_enabled, tva_rate,
                               created_at, updated_at, created_by)
  values (v_ref,
          v_client,
          coalesce(p_payload ->> 'client_name', 'Client'),
          p_payload ->> 'client_phone',
          v_addr, v_driver, v_plate,
          nullif(p_payload ->> 'receive_date', '')::date,
          p_payload ->> 'receive_hour',
          p_payload ->> 'receive_minute',
          v_total, v_advance, 0, v_advance, 0,
          'pending', p_payload ->> 'notes', v_bon,
          v_hist, v_tva_on, v_tva_rate,
          v_created, v_created, public.current_username())
  returning * into v_cmd;

  if v_addr is not null and v_client is not null then
    update public.clients
       set address = v_addr, updated_at = now()
     where id = v_client and coalesce(nullif(btrim(address), ''), '') is distinct from v_addr;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    insert into public.command_items (command_id, product_id, fiche_technic_id, product_name,
                                      quantity, unit_price, total_price, sell_by_unit, sell_unit)
    values (v_cmd.id,
            nullif(v_item ->> 'product_id', '')::uuid,
            nullif(v_item ->> 'fiche_technic_id', '')::uuid,
            coalesce(v_item ->> 'product_name', 'Produit'),
            coalesce((v_item ->> 'quantity')::numeric, 0),
            coalesce((v_item ->> 'unit_price')::numeric, 0),
            coalesce((v_item ->> 'total_price')::numeric, 0),
            coalesce((v_item ->> 'sell_by_unit')::boolean, false),
            v_item ->> 'sell_unit');
  end loop;

  -- L'acompte d'une ANCIENNE commande a ete encaisse dans le passe, hors du
  -- logiciel : il ne doit surtout pas gonfler la caisse d'aujourd'hui.
  if v_advance > 0 and not v_hist then
    insert into public.caisse_transactions (type, amount, date, description, category_name, ref_table, ref_id)
    values ('deposit', v_advance, v_created::date,
            'Acompte commande ' || v_ref, 'Commande', 'commands', v_cmd.id)
    on conflict (ref_table, ref_id) do nothing;
  end if;

  select * into v_cmd from public.commands where id = v_cmd.id;
  return v_cmd;
end;
$fn$;


-- ============================================================================
-- 09. pay_command() — le reglement se calcule sur le TTC
-- ============================================================================

create or replace function public.pay_command(
  p_command_id uuid, p_amount numeric, p_date date default current_date
) returns public.commands
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cmd public.commands;
  v_amt numeric := greatest(0, coalesce(p_amount, 0));
begin
  select * into v_cmd from public.commands where id = p_command_id;
  if v_cmd.id is null then
    raise exception 'Commande introuvable (%)', p_command_id;
  end if;

  v_amt := least(v_amt, greatest(0, coalesce(v_cmd.total_ttc, v_cmd.total_amount)
                                  - coalesce(v_cmd.paid_amount, 0)));
  if v_amt <= 0 then return v_cmd; end if;

  update public.commands
     set extra_paid = coalesce(extra_paid, 0) + v_amt,
         updated_at = now()
   where id = p_command_id;

  perform public.recompute_command_payments(p_command_id);

  -- l'argent d'une ancienne commande a circule hors du logiciel
  if not coalesce(v_cmd.is_historical, false) then
    insert into public.caisse_transactions (type, amount, date, description, category_name)
    values ('deposit', v_amt, coalesce(p_date, current_date),
            'Règlement commande ' || v_cmd.reference, 'Commande');
  end if;

  select * into v_cmd from public.commands where id = p_command_id;
  return v_cmd;
end;
$fn$;


-- ============================================================================
-- 10. create_command_delivery() — LA LIVRAISON EST UNE VENTE
-- ----------------------------------------------------------------------------
--  Reprend la version « ancienne livraison / lieu / chauffeur » et ajoute :
--    · l'option TVA du bon (par defaut celle de la commande),
--    · l'encaissement du jour et l'imputation de l'acompte disponible,
--    · la creation de la facture de vente correspondante.
-- ============================================================================

create or replace function public.create_command_delivery(p_payload jsonb)
returns public.command_deliveries
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_del      public.command_deliveries;
  v_cmd      public.commands;
  v_item     jsonb;
  v_ref      text;
  v_seq      int;
  v_driver   text := nullif(btrim(coalesce(p_payload ->> 'driver_name', '')), '');
  v_plate    text := nullif(btrim(coalesce(p_payload ->> 'driver_plate', '')), '');
  v_loc      text := nullif(btrim(coalesce(p_payload ->> 'location', '')), '');
  v_tva_on   boolean;
  v_tva_rate numeric;
  v_cash     numeric := greatest(0, coalesce((p_payload ->> 'cash_paid')::numeric, 0));
  v_adv      numeric := greatest(0, coalesce((p_payload ->> 'advance_applied')::numeric, 0));
begin
  if not public.has_perm('clients', 'edit') and not public.has_perm('clients', 'create') then
    raise exception 'Vous n''avez pas la permission de livrer une commande';
  end if;

  select * into v_cmd from public.commands where id = (p_payload ->> 'command_id')::uuid;
  if v_cmd.id is null then raise exception 'Commande introuvable'; end if;

  -- par defaut : le chauffeur prevu, l'adresse et la TVA de la commande
  v_driver := coalesce(v_driver, nullif(btrim(coalesce(v_cmd.driver_name, '')), ''));
  v_plate  := coalesce(v_plate,  nullif(btrim(coalesce(v_cmd.driver_plate, '')), ''));
  v_loc    := coalesce(v_loc,    nullif(btrim(coalesce(v_cmd.client_address, '')), ''));

  v_tva_on   := coalesce((p_payload ->> 'tva_enabled')::boolean, coalesce(v_cmd.tva_enabled, false));
  v_tva_rate := coalesce((p_payload ->> 'tva_rate')::numeric,
                         nullif(coalesce(v_cmd.tva_rate, 0), 0), 19);
  if not v_tva_on then v_tva_rate := 0; end if;

  -- l'acompte n'est jamais impute deux fois
  v_adv := least(v_adv, public.command_advance_available(v_cmd.id, null));

  select count(*) + 1 into v_seq from public.command_deliveries where command_id = v_cmd.id;
  v_ref := 'BL-' || v_cmd.reference || '-' || lpad(v_seq::text, 2, '0');
  while exists (select 1 from public.command_deliveries where reference = v_ref) loop
    v_seq := v_seq + 1;
    v_ref := 'BL-' || v_cmd.reference || '-' || lpad(v_seq::text, 2, '0');
  end loop;

  insert into public.command_deliveries (command_id, reference, date, delivered_at, notes,
                                         driver_name, driver_plate, location, is_historical,
                                         tva_enabled, tva_rate, advance_applied, cash_paid)
  values (v_cmd.id, v_ref,
          coalesce((p_payload ->> 'delivered_at')::timestamptz, now())::date,
          coalesce((p_payload ->> 'delivered_at')::timestamptz, now()),
          coalesce(p_payload ->> 'notes', ''),
          v_driver, v_plate, v_loc, coalesce(v_cmd.is_historical, false),
          v_tva_on, v_tva_rate, v_adv, v_cash)
  returning * into v_del;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    if coalesce((v_item ->> 'quantity')::numeric, 0) > 0 then
      insert into public.command_delivery_items (delivery_id, command_item_id, product_name, quantity, sell_unit)
      values (v_del.id,
              nullif(v_item ->> 'command_item_id', '')::uuid,
              coalesce(v_item ->> 'product_name', 'Produit'),
              coalesce((v_item ->> 'quantity')::numeric, 0),
              v_item ->> 'sell_unit');
    end if;
  end loop;

  -- ---- LA LIVRAISON RETIRE LES MATIERES DU STOCK — sauf ancienne livraison --
  if not coalesce(v_cmd.is_historical, false) then
    perform public.apply_command_delivery_stock(v_del.id);
  end if;

  -- ---- ... ET DEVIENT UNE FACTURE DE VENTE ---------------------------------
  perform public.apply_delivery_sale(v_del.id);

  perform public.recompute_command_delivery(v_cmd.id);
  perform public.log_activity('clients', 'deliver', 'command_deliveries', v_del.id, p_payload);

  select * into v_del from public.command_deliveries where id = v_del.id;
  return v_del;
end;
$fn$;


-- ============================================================================
-- 11. update_command_delivery() — la vente liee suit la modification
-- ============================================================================

create or replace function public.update_command_delivery(p_id uuid, p_payload jsonb)
returns public.command_deliveries
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_del      public.command_deliveries;
  v_item     jsonb;
  v_tva_on   boolean;
  v_tva_rate numeric;
  v_adv      numeric;
  v_cash     numeric;
begin
  select * into v_del from public.command_deliveries where id = p_id;
  if v_del.id is null then raise exception 'Livraison introuvable'; end if;

  v_tva_on   := coalesce((p_payload ->> 'tva_enabled')::boolean, coalesce(v_del.tva_enabled, false));
  v_tva_rate := coalesce((p_payload ->> 'tva_rate')::numeric,
                         nullif(coalesce(v_del.tva_rate, 0), 0), 19);
  if not v_tva_on then v_tva_rate := 0; end if;

  v_cash := greatest(0, coalesce((p_payload ->> 'cash_paid')::numeric, coalesce(v_del.cash_paid, 0)));
  v_adv  := greatest(0, coalesce((p_payload ->> 'advance_applied')::numeric, coalesce(v_del.advance_applied, 0)));
  v_adv  := least(v_adv, public.command_advance_available(v_del.command_id, p_id));

  update public.command_deliveries
     set delivered_at    = coalesce((p_payload ->> 'delivered_at')::timestamptz, delivered_at),
         date            = coalesce((p_payload ->> 'delivered_at')::timestamptz, delivered_at)::date,
         notes           = coalesce(p_payload ->> 'notes', notes),
         location        = case when p_payload ? 'location'
                                then nullif(btrim(coalesce(p_payload ->> 'location', '')), '')
                                else location end,
         driver_name     = case when p_payload ? 'driver_name'
                                then nullif(btrim(coalesce(p_payload ->> 'driver_name', '')), '')
                                else driver_name end,
         driver_plate    = case when p_payload ? 'driver_plate'
                                then nullif(btrim(coalesce(p_payload ->> 'driver_plate', '')), '')
                                else driver_plate end,
         tva_enabled     = v_tva_on,
         tva_rate        = v_tva_rate,
         advance_applied = v_adv,
         cash_paid       = v_cash,
         updated_at      = now()
   where id = p_id
  returning * into v_del;

  if p_payload ? 'items' then
    delete from public.command_delivery_items where delivery_id = p_id;
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
      if coalesce((v_item ->> 'quantity')::numeric, 0) > 0 then
        insert into public.command_delivery_items (delivery_id, command_item_id, product_name, quantity, sell_unit)
        values (p_id,
                nullif(v_item ->> 'command_item_id', '')::uuid,
                coalesce(v_item ->> 'product_name', 'Produit'),
                coalesce((v_item ->> 'quantity')::numeric, 0),
                v_item ->> 'sell_unit');
      end if;
    end loop;
  end if;

  -- ---- stock remis puis rededuit — sauf ancienne livraison ------------------
  if not coalesce(v_del.is_historical, false) then
    perform public.apply_command_delivery_stock(p_id);
  end if;

  -- ---- la facture de vente est reconstruite a l'identique -------------------
  perform public.apply_delivery_sale(p_id);

  perform public.recompute_command_delivery(v_del.command_id);
  perform public.log_activity('clients', 'deliver_update', 'command_deliveries', v_del.id, p_payload);

  select * into v_del from public.command_deliveries where id = p_id;
  return v_del;
end;
$fn$;


-- ============================================================================
-- 12. delete_command_delivery() — la vente liee part avec le bon
-- ----------------------------------------------------------------------------
--  `sales.delivery_id` est en ON DELETE CASCADE : supprimer le bon supprime la
--  facture, ses lignes, ses reglements et — via trg_sale_payments_caisse_del —
--  les ecritures de caisse correspondantes.
-- ============================================================================

create or replace function public.delete_command_delivery(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cmd uuid;
  v_ref text;
begin
  select command_id, reference into v_cmd, v_ref
    from public.command_deliveries where id = p_id;

  delete from public.client_debts
   where description = 'Reste livraison ' || coalesce(v_ref, '')
     and coalesce(total_paid, 0) = 0;

  -- le declencheur `command_deliveries_restore_stock` remet les matieres
  delete from public.command_deliveries where id = p_id;

  if v_cmd is not null then
    perform public.recompute_command_payments(v_cmd);
    perform public.recompute_command_delivery(v_cmd);
  end if;
end;
$fn$;


-- ============================================================================
-- 13. update_sale() / pay_sale_debt() — pilotent le bon de livraison
-- ----------------------------------------------------------------------------
--  Une facture issue d'une livraison se modifie et se regle depuis /ventes
--  comme n'importe quelle vente : les deux fonctions redirigent alors l'ecriture
--  vers le bon de livraison, qui reste la source de verite (valeur livree,
--  acompte impute, encaissement) et reconstruit la facture.
-- ============================================================================

create or replace function public.update_sale(p_id uuid, p_payload jsonb)
returns public.sales
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sale     public.sales;
  v_total    numeric;
  v_red      numeric;
  v_base     numeric;
  v_tva_on   boolean;
  v_tva_rate numeric;
  v_tva      numeric;
  v_final    numeric;
  v_paid     numeric;
  v_rest     numeric;
  v_date     date;
  v_status   public.sale_status;
begin
  select * into v_sale from public.sales where id = p_id;
  if v_sale.id is null then
    raise exception 'Vente introuvable (%)', p_id;
  end if;

  v_date := coalesce(nullif(p_payload ->> 'date', '')::date, v_sale.date);

  -- ---- facture issue d'une livraison : le bon reste la source de verite ----
  if v_sale.delivery_id is not null then
    v_tva_on   := coalesce((p_payload ->> 'tva_enabled')::boolean, coalesce(v_sale.tva_enabled, false));
    v_tva_rate := coalesce((p_payload ->> 'tva_rate')::numeric, nullif(coalesce(v_sale.tva_rate, 0), 0), 19);
    if not v_tva_on then v_tva_rate := 0; end if;
    v_paid := greatest(0, coalesce((p_payload ->> 'paid_amount')::numeric, v_sale.paid_amount));

    -- le montant paye saisi remplace tous les reglements libres
    delete from public.sale_payments
     where sale_id = p_id and coalesce(origin, '') not in ('delivery_advance', 'delivery_cash');

    update public.command_deliveries d
       set delivered_at = (v_date::timestamp + coalesce(d.delivered_at::time, '12:00'::time)),
           date         = v_date,
           notes        = coalesce(p_payload ->> 'note', d.notes),
           tva_enabled  = v_tva_on,
           tva_rate     = v_tva_rate,
           cash_paid    = greatest(0, v_paid - coalesce(d.advance_applied, 0)),
           updated_at   = now()
     where d.id = v_sale.delivery_id;

    perform public.apply_delivery_sale(v_sale.delivery_id);
    perform public.log_activity('sales', 'update', 'sales', p_id, p_payload);
    select * into v_sale from public.sales where id = p_id;
    return v_sale;
  end if;

  -- ---- vente ordinaire : comportement historique ---------------------------
  v_red   := greatest(0, coalesce((p_payload ->> 'reduction')::numeric, v_sale.reduction));
  v_total := coalesce(
    (select sum(quantity * selling_price) from public.sale_lines where sale_id = p_id),
    v_sale.total_amount);
  v_red   := least(v_red, v_total);
  v_base  := greatest(0, v_total - v_red);

  v_tva_on   := coalesce((p_payload ->> 'tva_enabled')::boolean, coalesce(v_sale.tva_enabled, false));
  v_tva_rate := coalesce((p_payload ->> 'tva_rate')::numeric, coalesce(v_sale.tva_rate, 0));
  if not v_tva_on then v_tva_rate := 0; end if;
  v_tva   := case when v_tva_on then round(v_base * v_tva_rate / 100, 2) else 0 end;
  v_final := v_base + v_tva;

  v_paid  := least(greatest(0, coalesce((p_payload ->> 'paid_amount')::numeric, v_sale.paid_amount)), v_final);
  v_rest  := greatest(0, v_final - v_paid);
  v_status := case when v_rest = 0 then 'paid'::public.sale_status else 'debt'::public.sale_status end;

  -- le trigger de suppression retire aussi les écritures de caisse liées
  delete from public.sale_payments where sale_id = p_id;
  if v_paid > 0 then
    insert into public.sale_payments (sale_id, date, amount, description)
    values (p_id, v_date, v_paid, 'Paiement vente (modifie)');
  end if;

  update public.sales
     set date         = v_date,
         total_amount = v_total,
         reduction    = v_red,
         tva_enabled  = v_tva_on,
         tva_rate     = v_tva_rate,
         tva_amount   = v_tva,
         final_amount = v_final,
         paid_amount  = v_paid,
         rest_amount  = v_rest,
         status       = v_status,
         note         = coalesce(p_payload ->> 'note', note),
         updated_at   = now()
   where id = p_id
  returning * into v_sale;

  delete from public.client_debts
   where description = 'Reste vente ' || v_sale.reference
     and coalesce(total_paid, 0) = 0;
  if v_rest > 0 and v_sale.client_id is not null then
    insert into public.client_debts (client_id, client_name, client_phone, total_debt, rest_amount,
                                     date, description, created_by)
    select v_sale.client_id, c.name, c.phone, v_rest, v_rest, v_date,
           'Reste vente ' || v_sale.reference, public.current_username()
      from public.clients c where c.id = v_sale.client_id;
  end if;

  perform public.log_activity('sales', 'update', 'sales', p_id, p_payload);
  return v_sale;
end;
$fn$;


create or replace function public.pay_sale_debt(
  p_sale_id uuid, p_amount numeric, p_date date default current_date,
  p_description text default 'Règlement dette'
) returns public.sales
language plpgsql
security definer
set search_path = public
as $fn$
declare v_sale public.sales;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Montant invalide';
  end if;

  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null then raise exception 'Vente introuvable (%)', p_sale_id; end if;

  -- le reglement garde sa propre date en caisse (origin NULL)
  insert into public.sale_payments (sale_id, date, amount, description)
  values (p_sale_id, coalesce(p_date, current_date), p_amount, p_description);

  if v_sale.delivery_id is not null then
    -- la facture est reconstruite a partir du bon : elle integre ce reglement
    perform public.apply_delivery_sale(v_sale.delivery_id);
  else
    update public.sales
       set paid_amount = least(final_amount, paid_amount + p_amount),
           rest_amount = greatest(0, final_amount - least(final_amount, paid_amount + p_amount)),
           status      = case when greatest(0, final_amount - least(final_amount, paid_amount + p_amount)) = 0
                              then 'paid'::public.sale_status else 'debt'::public.sale_status end,
           updated_at  = now()
     where id = p_sale_id;
  end if;

  perform public.log_activity('sales', 'pay', 'sales', p_sale_id, jsonb_build_object('amount', p_amount));
  select * into v_sale from public.sales where id = p_sale_id;
  return v_sale;
end;
$fn$;


-- ============================================================================
-- 14. SUPPRIMER LA VENTE D'UNE LIVRAISON SUPPRIME LE BON DE LIVRAISON
-- ----------------------------------------------------------------------------
--  La livraison ET sa facture sont une seule et meme operation : les deux
--  boutons « supprimer » doivent produire le meme resultat (matieres remises
--  en stock, commande revenue en « non livree », caisse nettoyee).
--  `pg_trigger_depth() = 1` distingue la suppression demandee par l'operateur
--  de la cascade declenchee par la suppression du bon lui-meme.
-- ============================================================================

create or replace function public.trg_sale_delete_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.delivery_id is not null and pg_trigger_depth() = 1 then
    delete from public.command_deliveries where id = old.delivery_id;
    if old.command_id is not null then
      perform public.recompute_command_payments(old.command_id);
      perform public.recompute_command_delivery(old.command_id);
    end if;
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_sales_delete_delivery on public.sales;
create trigger trg_sales_delete_delivery
  after delete on public.sales
  for each row execute function public.trg_sale_delete_delivery();


-- ============================================================================
-- 15. REPRISE DES LIVRAISONS DEJA ENREGISTREES
-- ----------------------------------------------------------------------------
--  Chaque bon de livraison existant recoit sa facture de vente : la valeur
--  livree est facturee, l'acompte encore disponible sur la commande y est
--  impute (sans ecriture de caisse : il y est deja entre) et le solde devient
--  une dette client. Les bons deja rattaches a une vente sont ignores.
-- ============================================================================

do $$
declare
  r      record;
  v_ht   numeric;
  v_left numeric;
begin
  for r in
    select d.id, d.command_id
      from public.command_deliveries d
     where not exists (select 1 from public.sales s where s.delivery_id = d.id)
     order by d.delivered_at
  loop
    select coalesce(sum(di.quantity * coalesce(px.unit_price, 0)), 0)
      into v_ht
      from public.command_delivery_items di
      left join lateral (
        select ci.unit_price
          from public.command_items ci
         where ci.command_id = r.command_id
           and (ci.id = di.command_item_id
                or (di.command_item_id is null and ci.product_name = di.product_name))
         order by (ci.id = di.command_item_id) desc
         limit 1
      ) px on true
     where di.delivery_id = r.id;

    v_left := public.command_advance_available(r.command_id, r.id);

    update public.command_deliveries
       set advance_applied = least(coalesce(v_left, 0), coalesce(v_ht, 0)),
           cash_paid       = 0
     where id = r.id;

    perform public.apply_delivery_sale(r.id);
  end loop;
end $$;


-- ============================================================================
-- 16. VUES DE CONTROLE + DROITS
-- ============================================================================

drop view if exists public.v_livraisons_ventes;
create view public.v_livraisons_ventes as
select d.reference                        as bon_livraison,
       c.reference                        as commande,
       c.client_name,
       d.delivered_at,
       d.location,
       d.total_ht,
       d.tva_enabled,
       d.tva_rate,
       d.tva_amount,
       d.total_ttc,
       d.advance_applied,
       d.cash_paid,
       d.paid_amount,
       d.rest_amount,
       s.reference                        as facture_vente,
       s.status                           as statut_vente
  from public.command_deliveries d
  join public.commands c on c.id = d.command_id
  left join public.sales s on s.delivery_id = d.id
 order by d.delivered_at desc;

grant select on public.v_livraisons_ventes to authenticated, service_role;

grant execute on function public.create_command(jsonb)                        to authenticated, service_role;
grant execute on function public.pay_command(uuid, numeric, date)             to authenticated, service_role;
grant execute on function public.create_command_delivery(jsonb)               to authenticated, service_role;
grant execute on function public.update_command_delivery(uuid, jsonb)         to authenticated, service_role;
grant execute on function public.delete_command_delivery(uuid)                to authenticated, service_role;
grant execute on function public.apply_delivery_sale(uuid)                    to authenticated, service_role;
grant execute on function public.recompute_command_payments(uuid)             to authenticated, service_role;
grant execute on function public.command_advance_available(uuid, uuid)        to authenticated, service_role;
grant execute on function public.update_sale(uuid, jsonb)                     to authenticated, service_role;
grant execute on function public.pay_sale_debt(uuid, numeric, date, text)     to authenticated, service_role;

commit;

-- ============================================================================
--  FIN
--
--  VERIFICATIONS RAPIDES
--    -- chaque bon de livraison a bien sa facture de vente :
--    select * from public.v_livraisons_ventes limit 20;
--
--    -- les ventes issues d'une livraison apparaissent dans /ventes :
--    select reference, date, final_amount, paid_amount, rest_amount, status,
--           delivery_id, command_id, tva_enabled, tva_rate, tva_amount
--      from public.sales where delivery_id is not null
--     order by date desc limit 20;
--
--    -- la caisse ne compte JAMAIS deux fois le meme argent :
--    select p.description, p.amount, p.skip_caisse, p.origin,
--           (select count(*) from public.caisse_transactions t
--             where t.ref_table = 'sale_payments' and t.ref_id = p.id) as ecritures
--      from public.sale_payments p order by p.created_at desc limit 20;
--
--    -- lignes de commande pointant une fiche technique supprimee : la vente
--    -- generee les facture par leur libelle, sans rattachement de recette
--    select ci.id, ci.product_name, ci.fiche_technic_id
--      from public.command_items ci
--     where ci.fiche_technic_id is not null
--       and not exists (select 1 from public.fiche_technics ft where ft.id = ci.fiche_technic_id);
--
--    -- TVA et reglements des commandes :
--    select reference, total_amount, tva_enabled, tva_rate, tva_amount,
--           total_ttc, advance_paid, extra_paid, paid_amount, rest_amount
--      from public.commands order by created_at desc limit 20;
-- ============================================================================
