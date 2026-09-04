-- ============================================================================
--  ALTECH PRODUCTION — MISE A JOUR
--  « ANCIENNES COMMANDES / ANCIENNES LIVRAISONS + FACTURATION SARL »
-- ----------------------------------------------------------------------------
--  A executer EN UNE SEULE FOIS dans Supabase -> SQL Editor.
--  Le script est idempotent : il peut etre relance sans risque.
--
--  CE QUE CE SCRIPT AJOUTE
--  -----------------------
--    1. IDENTIFIANTS FISCAUX DU CLIENT (bloc « DOIT » des factures)
--       clients.rc / clients.nif / clients.nis / clients.article
--
--    2. ANCIENNES COMMANDES (saisie retroactive, statistiques uniquement)
--       commands.is_historical
--         · create_command()  -> aucune ecriture de caisse pour l'acompte
--         · pay_command()      -> aucun encaissement de caisse
--       Elles alimentent l'historique du client / les rapports SANS toucher
--       ni la caisse, ni le stock, ni la production.
--
--    3. ANCIENNES LIVRAISONS (rattachees a une ancienne commande)
--       command_deliveries.is_historical  (herite de la commande)
--       command_deliveries.location       (lieu de livraison par bon)
--         · create_command_delivery() / update_command_delivery()
--           -> AUCUNE deduction de stock ni consommation quand la commande
--              est « ancienne ». Les quantites livrees sont tout de meme
--              comptabilisees (statistiques, compte rendu, bon imprime).
--
--  CONTENU
--  -------
--    01. clients — colonnes fiscales
--    02. commands — is_historical
--    03. command_deliveries — location + is_historical
--    04. create_command()            — acompte hors caisse si ancienne
--    05. pay_command()               — encaissement hors caisse si ancienne
--    06. create_command_delivery()   — livraison sans stock si ancienne
--    07. update_command_delivery()   — idem en modification
--    08. Droits
-- ============================================================================

begin;


-- ============================================================================
-- 01. CLIENTS — identifiants fiscaux (bloc « DOIT » de la facture)
-- ============================================================================

alter table public.clients
  add column if not exists rc      text,
  add column if not exists nif     text,
  add column if not exists nis     text,
  add column if not exists article text;

comment on column public.clients.rc      is 'Registre du commerce du client (imprime dans le bloc DOIT).';
comment on column public.clients.nif     is 'Numero d''identification fiscale du client.';
comment on column public.clients.nis     is 'Numero d''identification statistique du client.';
comment on column public.clients.article is 'Numero d''article d''imposition du client.';


-- ============================================================================
-- 02. COMMANDES — drapeau « ancienne commande »
-- ----------------------------------------------------------------------------
--  Une ancienne commande reconstitue l'historique commercial d'un client sans
--  generer aucune ecriture de caisse ni aucun mouvement de stock / production.
-- ============================================================================

alter table public.commands
  add column if not exists is_historical boolean not null default false;

comment on column public.commands.is_historical is
  'Ancienne commande saisie a posteriori : statistiques / historique uniquement, aucune ecriture de caisse ni de stock.';

create index if not exists commands_historical_idx
  on public.commands (is_historical) where is_historical;


-- ============================================================================
-- 03. LIVRAISONS — lieu de livraison + drapeau « ancienne livraison »
-- ----------------------------------------------------------------------------
--  `location` : lieu reellement livre pour ce bon (Beni Mered, Blida, ...),
--  propose par defaut a l'adresse de la commande, modifiable a chaque bon.
--  `is_historical` : herite de la commande — une ancienne commande ne peut
--  donner que des anciennes livraisons (sans deduction de stock).
-- ============================================================================

alter table public.command_deliveries
  add column if not exists location      text,
  add column if not exists is_historical boolean not null default false;

comment on column public.command_deliveries.location is
  'Lieu de livraison de ce bon (defaut : adresse de la commande).';
comment on column public.command_deliveries.is_historical is
  'Ancienne livraison (commande ancienne) : aucune deduction de stock.';


-- ============================================================================
-- 04. create_command() — l'acompte d'une ANCIENNE commande n'entre pas en caisse
-- ----------------------------------------------------------------------------
--  Reprend la derniere version (adresse, chauffeur, matricule, n° de bon, date
--  de creation editable) et ajoute : la colonne `is_historical`, et la
--  neutralisation de l'ecriture de caisse quand la commande est ancienne.
--  Aucun consume_stock() ici : la matiere ne part qu'a la livraison.
-- ============================================================================

create or replace function public.create_command(p_payload jsonb)
returns public.commands
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cmd     public.commands;
  v_ref     text;
  v_item    jsonb;
  v_total   numeric := 0;
  v_advance numeric := coalesce((p_payload ->> 'advance_paid')::numeric, 0);
  v_seq     int;
  v_created timestamptz := coalesce(nullif(p_payload ->> 'created_at', '')::timestamptz, now());
  v_bon     text := nullif(btrim(coalesce(p_payload ->> 'bon_number', '')), '');
  v_addr    text := nullif(btrim(coalesce(p_payload ->> 'client_address', '')), '');
  v_driver  text := nullif(btrim(coalesce(p_payload ->> 'driver_name', '')), '');
  v_plate   text := nullif(btrim(coalesce(p_payload ->> 'driver_plate', '')), '');
  v_client  uuid := nullif(p_payload ->> 'client_id', '')::uuid;
  v_hist    boolean := coalesce((p_payload ->> 'is_historical')::boolean, false);
  v_year    text := to_char(v_created, 'YYYY');
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

  if v_addr is null and v_client is not null then
    select nullif(btrim(address), '') into v_addr from public.clients where id = v_client;
  end if;

  insert into public.commands (reference, client_id, client_name, client_phone, client_address,
                               driver_name, driver_plate, receive_date,
                               receive_hour, receive_minute, total_amount, advance_paid,
                               paid_amount, rest_amount, status, notes, bon_number,
                               is_historical, created_at, updated_at, created_by)
  values (v_ref,
          v_client,
          coalesce(p_payload ->> 'client_name', 'Client'),
          p_payload ->> 'client_phone',
          v_addr, v_driver, v_plate,
          nullif(p_payload ->> 'receive_date', '')::date,
          p_payload ->> 'receive_hour',
          p_payload ->> 'receive_minute',
          v_total, v_advance, v_advance, greatest(0, v_total - v_advance),
          'pending', p_payload ->> 'notes', v_bon,
          v_hist, v_created, v_created, public.current_username())
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

  -- ---- AUCUN consume_stock() ICI : la matiere ne part qu'a la livraison ----

  -- L'acompte d'une ANCIENNE commande a ete encaisse dans le passe, hors du
  -- logiciel : il ne doit surtout pas gonfler la caisse d'aujourd'hui.
  if v_advance > 0 and not v_hist then
    insert into public.caisse_transactions (type, amount, date, description, category_name, ref_table, ref_id)
    values ('deposit', v_advance, v_created::date,
            'Acompte commande ' || v_ref, 'Commande', 'commands', v_cmd.id);
  end if;

  return v_cmd;
end;
$fn$;


-- ============================================================================
-- 05. pay_command() — un reglement d'ANCIENNE commande n'entre pas en caisse
-- ----------------------------------------------------------------------------
--  Reprend la signature existante (id, montant, date) et neutralise l'ecriture
--  de caisse quand la commande est ancienne.
-- ============================================================================

create or replace function public.pay_command(
  p_command_id uuid, p_amount numeric, p_date date default current_date
) returns public.commands
language plpgsql
security definer
set search_path = public
as $fn$
declare v_cmd public.commands;
begin
  update public.commands
     set paid_amount = least(total_amount, paid_amount + p_amount),
         rest_amount = greatest(0, total_amount - least(total_amount, paid_amount + p_amount)),
         updated_at  = now()
   where id = p_command_id
  returning * into v_cmd;

  if v_cmd.id is null then
    raise exception 'Commande introuvable (%)', p_command_id;
  end if;

  -- l'argent d'une ancienne commande a circule hors du logiciel
  if not coalesce(v_cmd.is_historical, false) then
    insert into public.caisse_transactions (type, amount, date, description, category_name)
    values ('deposit', p_amount, coalesce(p_date, current_date),
            'Règlement commande ' || v_cmd.reference, 'Commande');
  end if;

  return v_cmd;
end;
$fn$;


-- ============================================================================
-- 06. create_command_delivery() — pas de stock pour une ANCIENNE livraison
-- ----------------------------------------------------------------------------
--  Reprend la version « deduction reelle du stock » et ajoute :
--    · le lieu de livraison (`location`) du bon,
--    · l'heritage du drapeau `is_historical` de la commande,
--    · le court-circuit de apply_command_delivery_stock() pour une ancienne
--      livraison (aucune matiere retiree, aucune production).
-- ============================================================================

create or replace function public.create_command_delivery(p_payload jsonb)
returns public.command_deliveries
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_del    public.command_deliveries;
  v_cmd    public.commands;
  v_item   jsonb;
  v_ref    text;
  v_seq    int;
  v_driver text := nullif(btrim(coalesce(p_payload ->> 'driver_name', '')), '');
  v_plate  text := nullif(btrim(coalesce(p_payload ->> 'driver_plate', '')), '');
  v_loc    text := nullif(btrim(coalesce(p_payload ->> 'location', '')), '');
begin
  if not public.has_perm('clients', 'edit') and not public.has_perm('clients', 'create') then
    raise exception 'Vous n''avez pas la permission de livrer une commande';
  end if;

  select * into v_cmd from public.commands where id = (p_payload ->> 'command_id')::uuid;
  if v_cmd.id is null then raise exception 'Commande introuvable'; end if;

  -- par defaut : le chauffeur prevu et l'adresse de la commande
  v_driver := coalesce(v_driver, nullif(btrim(coalesce(v_cmd.driver_name, '')), ''));
  v_plate  := coalesce(v_plate,  nullif(btrim(coalesce(v_cmd.driver_plate, '')), ''));
  v_loc    := coalesce(v_loc,    nullif(btrim(coalesce(v_cmd.client_address, '')), ''));

  select count(*) + 1 into v_seq from public.command_deliveries where command_id = v_cmd.id;
  v_ref := 'BL-' || v_cmd.reference || '-' || lpad(v_seq::text, 2, '0');
  while exists (select 1 from public.command_deliveries where reference = v_ref) loop
    v_seq := v_seq + 1;
    v_ref := 'BL-' || v_cmd.reference || '-' || lpad(v_seq::text, 2, '0');
  end loop;

  insert into public.command_deliveries (command_id, reference, date, delivered_at, notes,
                                         driver_name, driver_plate, location, is_historical)
  values (v_cmd.id, v_ref,
          coalesce((p_payload ->> 'delivered_at')::timestamptz, now())::date,
          coalesce((p_payload ->> 'delivered_at')::timestamptz, now()),
          coalesce(p_payload ->> 'notes', ''),
          v_driver, v_plate, v_loc, coalesce(v_cmd.is_historical, false))
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

  -- ---- LA LIVRAISON RETIRE LES MATIERES DU STOCK — sauf ancienne livraison ----
  -- Une ancienne livraison ne fait que comptabiliser des quantites deja
  -- livrees dans le passe : aucune matiere ne doit quitter le stock actuel.
  if not coalesce(v_cmd.is_historical, false) then
    perform public.apply_command_delivery_stock(v_del.id);
  end if;

  perform public.recompute_command_delivery(v_cmd.id);
  perform public.log_activity('clients', 'deliver', 'command_deliveries', v_del.id, p_payload);
  return v_del;
end;
$fn$;


-- ============================================================================
-- 07. update_command_delivery() — idem en modification
-- ============================================================================

create or replace function public.update_command_delivery(p_id uuid, p_payload jsonb)
returns public.command_deliveries
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_del  public.command_deliveries;
  v_item jsonb;
begin
  update public.command_deliveries
     set delivered_at = coalesce((p_payload ->> 'delivered_at')::timestamptz, delivered_at),
         date         = coalesce((p_payload ->> 'delivered_at')::timestamptz, delivered_at)::date,
         notes        = coalesce(p_payload ->> 'notes', notes),
         location     = case when p_payload ? 'location'
                             then nullif(btrim(coalesce(p_payload ->> 'location', '')), '')
                             else location end,
         driver_name  = case when p_payload ? 'driver_name'
                             then nullif(btrim(coalesce(p_payload ->> 'driver_name', '')), '')
                             else driver_name end,
         driver_plate = case when p_payload ? 'driver_plate'
                             then nullif(btrim(coalesce(p_payload ->> 'driver_plate', '')), '')
                             else driver_plate end,
         updated_at   = now()
   where id = p_id
  returning * into v_del;

  if v_del.id is null then raise exception 'Livraison introuvable'; end if;

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

  -- ---- stock remis puis rededuit — sauf ancienne livraison (rien en stock) ----
  if not coalesce(v_del.is_historical, false) then
    perform public.apply_command_delivery_stock(p_id);
  end if;

  perform public.recompute_command_delivery(v_del.command_id);
  perform public.log_activity('clients', 'deliver_update', 'command_deliveries', v_del.id, p_payload);
  return v_del;
end;
$fn$;


-- ============================================================================
-- 08. DROITS
-- ============================================================================

grant execute on function public.create_command(jsonb)                to authenticated, service_role;
grant execute on function public.pay_command(uuid, numeric, date)     to authenticated, service_role;
grant execute on function public.create_command_delivery(jsonb)       to authenticated, service_role;
grant execute on function public.update_command_delivery(uuid, jsonb) to authenticated, service_role;

commit;

-- ============================================================================
--  FIN
--
--  VERIFICATIONS RAPIDES
--    -- une ancienne commande n'ecrit rien en caisse :
--    select reference, is_historical, paid_amount from public.commands
--     where is_historical order by created_at desc limit 10;
--    -- une ancienne livraison ne retire aucune matiere :
--    select d.reference, d.is_historical, d.location,
--           (select count(*) from public.command_delivery_consumptions c
--             where c.delivery_id = d.id) as matieres_deduites
--      from public.command_deliveries d
--     where d.is_historical order by d.delivered_at desc limit 10;
-- ============================================================================
