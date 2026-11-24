-- =====================================================================
-- Funções auxiliares saem do schema exposto pela API (não viram /rpc/...).
-- Policies continuam funcionando (guardam referência pelo OID).
-- Funções que chamam as auxiliares pelo nome são recriadas com o novo caminho.
-- =====================================================================
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

alter function public.is_store_member(uuid, public.member_role[]) set schema private;
alter function public.is_store_public(uuid)                       set schema private;
alter function public._price_order(uuid, jsonb, boolean)          set schema private;
alter function public._release_coupon(uuid)                       set schema private;

do $$
declare f record; def text;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc like '%public.is_store_member%' or p.prosrc like '%public._price_order%'
            or p.prosrc like '%public._release_coupon%' or p.prosrc like '%public.is_store_public%')
  loop
    def := pg_get_functiondef(f.oid);
    def := replace(def, 'public.is_store_member', 'private.is_store_member');
    def := replace(def, 'public.is_store_public', 'private.is_store_public');
    def := replace(def, 'public._price_order',    'private._price_order');
    def := replace(def, 'public._release_coupon', 'private._release_coupon');
    execute def;
  end loop;
end $$;
