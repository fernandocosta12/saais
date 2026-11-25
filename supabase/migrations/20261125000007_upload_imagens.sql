-- =====================================================================
-- Fotos dos pratos e logo da loja no Supabase Storage.
-- * Bucket público para LEITURA (o cardápio é público), sem listagem.
-- * Envio/remoção só por dono ou gerente, e só na pasta da própria loja:
--     store-media/<store_id>/<arquivo>
-- * Até 2 MB, só JPEG/PNG/WebP (o painel já reduz e comprime antes de enviar).
-- * Produtos e lojas só aceitam imagens deste bucket (nada de links externos).
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-media', 'store-media', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Confere se o caminho é <uuid-da-loja>/<arquivo> e se o usuário administra essa loja
create or replace function private.can_manage_media(p_name text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare v_store uuid; v_parts text[] := string_to_array(p_name, '/');
begin
  if array_length(v_parts, 1) <> 2 or v_parts[2] !~ '^[a-z0-9-]{8,80}\.(webp|jpg|jpeg|png)$' then
    return false;
  end if;
  begin v_store := v_parts[1]::uuid; exception when others then return false; end;
  return private.is_store_member(v_store, array['owner','manager']::public.member_role[]);
end;
$$;
revoke all on function private.can_manage_media(text) from public, anon;
grant execute on function private.can_manage_media(text) to authenticated;

-- Sem policy de SELECT: ninguém lista os arquivos pela API (a leitura pública é pela URL)
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'store-media' and private.can_manage_media(name));
create policy media_update on storage.objects for update to authenticated
  using (bucket_id = 'store-media' and private.can_manage_media(name))
  with check (bucket_id = 'store-media' and private.can_manage_media(name));
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'store-media' and private.can_manage_media(name));

-- Só imagens do nosso bucket, na pasta da própria loja
alter table public.products add constraint products_image_from_storage check (
  image_url is null or image_url like 'https://tjhuayoppfvdyzfbfpew.supabase.co/storage/v1/object/public/store-media/' || store_id::text || '/%');
alter table public.stores add constraint stores_logo_from_storage check (
  logo_url is null or logo_url like 'https://tjhuayoppfvdyzfbfpew.supabase.co/storage/v1/object/public/store-media/' || id::text || '/%');

-- A remoção pela API do Storage também exige permissão de leitura do objeto:
-- liberada só para quem administra a loja dona da pasta (visitantes seguem sem listar nada).
create policy media_select_managers on storage.objects for select to authenticated
  using (bucket_id = 'store-media' and private.can_manage_media(name));
