-- =====================================================================
-- ARON Signage v2 – CÀI ĐẶT ĐẦY ĐỦ CHO PROJECT SUPABASE MỚI (độc lập với app cũ)
-- Supabase Dashboard (project MỚI) → SQL Editor → New query → dán toàn bộ → Run
-- Chạy lại nhiều lần vẫn an toàn.
--
-- Tài khoản OWNER: email bên dưới. Khi tạo user có email này (Authentication →
-- Users → Add user), user tự động thành Admin + Owner.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A) NGƯỜI DÙNG & VAI TRÒ
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'none'
             check (role in ('admin','editor','creator','none')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Tự tạo hồ sơ (role = 'none' = chưa có quyền gì) khi có tài khoản mới
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Tạo hồ sơ cho các tài khoản đã có sẵn (nếu có)
insert into public.profiles (id, email)
select id, email from auth.users on conflict (id) do nothing;

-- Hàm lấy vai trò của người đang gọi
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- Policies cho profiles
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='profiles' loop
    execute format('drop policy %I on public.profiles', r.policyname);
  end loop;
end $$;
create policy "profiles: xem của mình hoặc admin xem tất cả" on public.profiles
  for select to authenticated using (id = auth.uid() or public.my_role() = 'admin');
create policy "profiles: admin đổi vai trò người khác" on public.profiles
  for update to authenticated
  using (public.my_role() = 'admin' and id <> auth.uid())
  with check (public.my_role() = 'admin' and id <> auth.uid());
create policy "profiles: admin xóa người khác" on public.profiles
  for delete to authenticated using (public.my_role() = 'admin' and id <> auth.uid());
-- Không ai tự sửa được role của chính mình (không có policy cho việc đó)


alter table public.profiles add column if not exists is_owner boolean not null default false;

-- Chỉ có tối đa 1 Owner
create unique index if not exists profiles_single_owner on public.profiles (is_owner) where is_owner;

-- Đặt Owner
update public.profiles set is_owner = false where is_owner and lower(email) <> 'kietdmt@aron.com.vn';
update public.profiles set is_owner = true, role = 'admin' where lower(email) = 'kietdmt@aron.com.vn';

-- Chặn ở server: không ai (kể cả Admin khác) gỡ hay đổi vai trò Owner, không ai tự phong Owner
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Chạy trực tiếp từ SQL Editor / service_role: cho phép (để bạn vẫn quản trị được)
  if coalesce(auth.role(), '') not in ('anon','authenticated') then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.is_owner then raise exception 'Không thể gỡ tài khoản Owner'; end if;
    return old;
  end if;

  if new.is_owner is distinct from old.is_owner then
    raise exception 'Không thể thay đổi Owner';
  end if;
  if old.is_owner and new.role is distinct from old.role then
    raise exception 'Không thể thay đổi vai trò của Owner';
  end if;
  if new.id is distinct from old.id or new.email is distinct from old.email then
    raise exception 'Không được sửa id/email của hồ sơ';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update or delete on public.profiles
  for each row execute function public.profiles_guard();

-- User mới: mặc định chưa có quyền; riêng email Owner tự thành Admin + Owner
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role, is_owner)
  values (new.id, new.email,
          case when lower(new.email) = 'kietdmt@aron.com.vn' then 'admin' else 'none' end,
          lower(new.email) = 'kietdmt@aron.com.vn')
  on conflict (id) do nothing;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- B) MÃ PIN (bcrypt, client không đọc được)
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sig_secrets (
  id       int primary key default 1 check (id = 1),
  pin_hash text
);
alter table public.sig_secrets enable row level security;  -- không có policy = không ai đọc trực tiếp được

create table if not exists public.pin_attempts (
  at timestamptz not null default now(),
  ok boolean not null
);
alter table public.pin_attempts enable row level security;

create or replace function public.set_pin(p text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'Chỉ Admin được đặt mã PIN';
  end if;
  if p is null or length(p) < 4 then
    raise exception 'Mã PIN phải từ 4 ký tự';
  end if;
  insert into public.sig_secrets (id, pin_hash) values (1, crypt(p, gen_salt('bf', 10)))
  on conflict (id) do update set pin_hash = excluded.pin_hash;
end $$;

create or replace function public.has_pin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sig_secrets where id = 1 and pin_hash is not null)
$$;

-- Giới hạn: quá 10 lần sai trong 10 phút → tạm khóa
revoke all on function public.set_pin(text) from public, anon;
revoke all on function public.has_pin() from public;
grant execute on function public.set_pin(text) to authenticated;
grant execute on function public.has_pin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- C) THƯ VIỆN MEDIA & NGUỒN LỊCH/KPI BÍ MẬT
-- ---------------------------------------------------------------------
-- 1) THƯ VIỆN MEDIA (Supabase Storage – gói Free: 1 GB, tối đa 50 MB/file)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800,
        array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media: đọc công khai" on storage.objects;
drop policy if exists "media: tải lên"       on storage.objects;
drop policy if exists "media: xóa"           on storage.objects;

create policy "media: đọc công khai" on storage.objects
  for select to anon, authenticated using (bucket_id = 'media');
create policy "media: tải lên" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and public.my_role() in ('admin','editor','creator'));
create policy "media: xóa" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and public.my_role() in ('admin','editor'));

-- 2) NGUỒN DỮ LIỆU BÍ MẬT (link lịch ICS, link Google Sheet)
--    Link lịch "bí mật" KHÔNG được để trong dữ liệu công khai → lưu ở bảng riêng,
--    Tivi chỉ biết mã (id), Edge Function "feed" mới đọc được link thật.
create table if not exists public.sig_feeds (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('ics','csv')),
  url        text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.sig_feeds enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='sig_feeds' loop
    execute format('drop policy %I on public.sig_feeds', r.policyname);
  end loop;
end $$;
create policy "feeds: người có quyền xem"  on public.sig_feeds for select to authenticated
  using (public.my_role() in ('admin','editor','creator'));
create policy "feeds: người có quyền thêm" on public.sig_feeds for insert to authenticated
  with check (public.my_role() in ('admin','editor','creator'));
create policy "feeds: editor/admin sửa"    on public.sig_feeds for update to authenticated
  using (public.my_role() in ('admin','editor')) with check (public.my_role() in ('admin','editor'));
create policy "feeds: admin xóa"           on public.sig_feeds for delete to authenticated
  using (public.my_role() = 'admin');
-- (anon không có policy → Tivi/người lạ không đọc được link)

-- ---------------------------------------------------------------------
-- 0) Hàm phân quyền tiện dụng
-- ---------------------------------------------------------------------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','editor','creator'), false) $$;
create or replace function public.is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','editor'), false) $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false) $$;
create or replace function public.my_email() returns text
language sql stable security definer set search_path = public as $$
  select email from public.profiles where id = auth.uid() $$;

-- ---------------------------------------------------------------------
-- 1) BẢNG
-- ---------------------------------------------------------------------
-- Cài đặt chung (1 dòng)
create table if not exists public.sig_settings (
  id         int primary key default 1 check (id = 1),
  company    text not null default '',
  ticker     text not null default '',
  logo       text not null default '',
  lay        text not null default 'full' check (lay in ('full','side')),
  sidenote   text not null default '',
  pin_lock   boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.sig_settings (id) values (1) on conflict (id) do nothing;
alter table public.sig_settings add column if not exists migrated boolean not null default false;

-- Nhóm màn hình (chi nhánh / tầng / khu vực)
create table if not exists public.screen_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

-- Màn hình (mỗi Tivi một dòng)
create table if not exists public.screens (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'Tivi mới',
  location     text not null default '',
  group_id     uuid references public.screen_groups(id) on delete set null,
  token_hash   text not null unique,              -- sha256 của mã bí mật lưu trên Tivi
  pair_code    text,                              -- mã 6 số khi chờ ghép nối
  pair_expires timestamptz,
  status       text not null default 'pending' check (status in ('pending','active','disabled')),
  -- Ghi đè riêng cho màn này (để trống = dùng cài đặt chung)
  ticker       text,
  lay          text check (lay in ('full','side')),
  sidenote     text,
  last_seen    timestamptz,
  info         jsonb not null default '{}'::jsonb, -- phiên bản app, độ phân giải, đang phát gì...
  created_at   timestamptz not null default now(),
  paired_at    timestamptz,
  paired_by    text
);
create unique index if not exists screens_pair_code_uq on public.screens (pair_code) where status = 'pending';

-- Nội dung (mỗi slide một dòng)
create table if not exists public.slides (
  id                uuid primary key default gen_random_uuid(),
  sort              double precision not null default extract(epoch from now()),
  type              text not null,
  data              jsonb not null default '{}'::jsonb,
  enabled           boolean not null default true,
  status            text not null default 'approved' check (status in ('pending','approved','rejected')),
  target_all        boolean not null default true,
  target_groups     uuid[] not null default '{}',
  target_screens    uuid[] not null default '{}',
  created_by        uuid default auth.uid(),
  created_by_email  text,
  created_at        timestamptz not null default now(),
  updated_by_email  text,
  updated_at        timestamptz not null default now(),
  reviewed_by_email text,
  reviewed_at       timestamptz
);
create index if not exists slides_sort_idx on public.slides (sort);

-- Thông báo khẩn cấp (có phạm vi)
create table if not exists public.alerts (
  id               uuid primary key default gen_random_uuid(),
  title            text not null default '',
  msg              text not null default '',
  level            text not null default 'red' check (level in ('red','orange','blue')),
  sound            text not null default '10' check (sound in ('off','once','10','30')),
  vol              numeric not null default 0.18 check (vol between 0.03 and 0.4),
  target_all       boolean not null default true,
  target_groups    uuid[] not null default '{}',
  target_screens   uuid[] not null default '{}',
  starts_at        timestamptz not null default now(),
  until            timestamptz,
  active           boolean not null default true,
  created_by_email text,
  created_at       timestamptz not null default now(),
  stopped_at       timestamptz,
  stopped_by_email text
);

-- Lệnh điều khiển từ xa
create table if not exists public.screen_commands (
  id               bigserial primary key,
  screen_id        uuid not null references public.screens(id) on delete cascade,
  cmd              text not null check (cmd in ('reload','identify','next')),
  created_at       timestamptz not null default now(),
  done_at          timestamptz,
  created_by_email text
);

-- Bộ đếm phiên bản dữ liệu: Tivi so sánh số này để biết khi nào cần tải lại
create table if not exists public.sig_rev (
  id  int primary key default 1 check (id = 1),
  rev bigint not null default 1
);
insert into public.sig_rev (id) values (1) on conflict (id) do nothing;

-- PIN: đếm sai theo TỪNG Tivi (bản cũ đếm chung → ai cũng khóa được mọi Tivi)
alter table public.pin_attempts add column if not exists screen_id uuid;

-- ---------------------------------------------------------------------
-- 2) TRIGGER
-- ---------------------------------------------------------------------
create or replace function public.bump_rev() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.sig_rev set rev = rev + 1 where id = 1;
  return null;
end $$;

drop trigger if exists bump_settings on public.sig_settings;
create trigger bump_settings after insert or update or delete on public.sig_settings
  for each statement execute function public.bump_rev();
drop trigger if exists bump_groups on public.screen_groups;
create trigger bump_groups after insert or update or delete on public.screen_groups
  for each statement execute function public.bump_rev();
drop trigger if exists bump_slides on public.slides;
create trigger bump_slides after insert or update or delete on public.slides
  for each statement execute function public.bump_rev();
drop trigger if exists bump_alerts on public.alerts;
create trigger bump_alerts after insert or update or delete on public.alerts
  for each statement execute function public.bump_rev();
-- Chỉ các cột ảnh hưởng nội dung mới làm tăng rev (heartbeat cập nhật last_seen thì không)
drop trigger if exists bump_screens on public.screens;
create trigger bump_screens after update of name, location, group_id, status, ticker, lay, sidenote or delete on public.screens
  for each statement execute function public.bump_rev();

-- Slide: ghi người tạo/sửa, chặn Creator vượt quyền
create or replace function public.slides_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.my_role();
begin
  if coalesce(auth.role(), '') not in ('anon','authenticated') then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_by_email := public.my_email();
    new.created_at := now();
    if r = 'creator' then new.status := 'pending'; end if;
  else
    new.created_by := old.created_by;
    new.created_by_email := old.created_by_email;
    new.created_at := old.created_at;
    if r = 'creator' then new.status := 'pending'; end if;
    if new.status is distinct from old.status and new.status <> 'pending' then
      new.reviewed_by_email := public.my_email();
      new.reviewed_at := now();
    end if;
  end if;
  new.updated_by_email := public.my_email();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists slides_guard on public.slides;
create trigger slides_guard before insert or update on public.slides
  for each row execute function public.slides_guard();

-- ---------------------------------------------------------------------
-- 3) RLS – Tivi (anon) KHÔNG đọc trực tiếp bảng nào, chỉ gọi hàm RPC bên dưới
-- ---------------------------------------------------------------------
do $$ declare t text; r record; begin
  foreach t in array array['sig_settings','screen_groups','screens','slides','alerts','screen_commands','sig_rev'] loop
    execute format('alter table public.%I enable row level security', t);
    for r in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', r.policyname, t);
    end loop;
  end loop;
end $$;

create policy "settings: staff xem"  on public.sig_settings for select to authenticated using (public.is_staff());
create policy "settings: admin sửa"  on public.sig_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "groups: staff xem"    on public.screen_groups for select to authenticated using (public.is_staff());
create policy "groups: admin thêm"   on public.screen_groups for insert to authenticated with check (public.is_admin());
create policy "groups: admin sửa"    on public.screen_groups for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "groups: admin xóa"    on public.screen_groups for delete to authenticated using (public.is_admin());

create policy "screens: staff xem"   on public.screens for select to authenticated using (public.is_staff());
create policy "screens: admin sửa"   on public.screens for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "screens: admin gỡ"    on public.screens for delete to authenticated using (public.is_admin());
-- (thêm màn hình chỉ qua hàm screen_register/screen_claim)

create policy "slides: staff xem"    on public.slides for select to authenticated using (public.is_staff());
create policy "slides: thêm"         on public.slides for insert to authenticated
  with check (public.is_editor() or (public.my_role() = 'creator' and status = 'pending'));
create policy "slides: editor sửa"   on public.slides for update to authenticated
  using (public.is_editor()) with check (public.is_editor());
create policy "slides: creator sửa bài chờ duyệt của mình" on public.slides for update to authenticated
  using (public.my_role() = 'creator' and created_by = auth.uid() and status = 'pending')
  with check (public.my_role() = 'creator' and created_by = auth.uid() and status = 'pending');
create policy "slides: admin xóa"    on public.slides for delete to authenticated using (public.is_admin());
create policy "slides: creator xóa bài chờ duyệt của mình" on public.slides for delete to authenticated
  using (public.my_role() = 'creator' and created_by = auth.uid() and status = 'pending');

create policy "alerts: staff xem"    on public.alerts for select to authenticated using (public.is_staff());
create policy "alerts: admin phát"   on public.alerts for insert to authenticated with check (public.is_admin());
create policy "alerts: admin tắt"    on public.alerts for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "cmds: staff xem"      on public.screen_commands for select to authenticated using (public.is_staff());
create policy "cmds: editor gửi lệnh" on public.screen_commands for insert to authenticated with check (public.is_editor());

create policy "rev: staff xem"       on public.sig_rev for select to authenticated using (public.is_staff());

-- Link lịch bí mật: Creator chỉ thấy link do mình tạo (bản cũ thấy tất cả)
drop policy if exists "feeds: người có quyền xem" on public.sig_feeds;
create policy "feeds: người có quyền xem" on public.sig_feeds for select to authenticated
  using (public.is_editor() or (public.my_role() = 'creator' and created_by = auth.uid()));

-- ---------------------------------------------------------------------
-- 4) HÀM CHO TIVI (anon gọi được, xác thực bằng mã bí mật của từng Tivi)
-- ---------------------------------------------------------------------
create or replace function public._screen_by_token(p_token text) returns public.screens
language sql stable security definer set search_path = public, extensions as $$
  select * from public.screens
   where length(coalesce(p_token,'')) >= 32
     and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;
revoke all on function public._screen_by_token(text) from public, anon, authenticated;

create or replace function public._new_pair_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare c text; n int := 0;
begin
  loop
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.screens where pair_code = c and status = 'pending');
    n := n + 1; if n > 50 then raise exception 'Không tạo được mã ghép nối'; end if;
  end loop;
  return c;
end $$;
revoke all on function public._new_pair_code() from public, anon, authenticated;

-- Tivi đăng ký lần đầu (hoặc lấy lại mã ghép nối nếu đang chờ)
create or replace function public.screen_register(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare s public.screens;
begin
  if length(coalesce(p_token,'')) < 32 or length(p_token) > 128 then raise exception 'Mã thiết bị không hợp lệ'; end if;
  s := public._screen_by_token(p_token);
  if s.id is null then
    delete from public.screens where status = 'pending' and created_at < now() - interval '1 day';
    if (select count(*) from public.screens where status = 'pending' and created_at > now() - interval '10 minutes') >= 30 then
      raise exception 'Quá nhiều yêu cầu ghép nối, thử lại sau ít phút';
    end if;
    insert into public.screens (token_hash, pair_code, pair_expires, status)
    values (encode(extensions.digest(p_token,'sha256'),'hex'), public._new_pair_code(), now() + interval '30 minutes', 'pending')
    returning * into s;
  elsif s.status = 'pending' and (s.pair_expires is null or s.pair_expires < now()) then
    update public.screens set pair_code = public._new_pair_code(), pair_expires = now() + interval '30 minutes'
     where id = s.id returning * into s;
  end if;
  return jsonb_build_object('status', s.status, 'code', case when s.status = 'pending' then s.pair_code end, 'id', s.id);
end $$;

-- Tivi báo "còn sống" (mỗi ~20 giây) → nhận số rev + lệnh từ xa
create or replace function public.screen_ping(p_token text, p_info jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare s public.screens; cmds jsonb;
begin
  s := public._screen_by_token(p_token);
  if s.id is null then return jsonb_build_object('status','unknown'); end if;
  if s.status = 'pending' then
    if s.pair_expires is null or s.pair_expires < now() then
      update public.screens set pair_code = public._new_pair_code(), pair_expires = now() + interval '30 minutes'
       where id = s.id returning * into s;
    end if;
    update public.screens set last_seen = now() where id = s.id;
    return jsonb_build_object('status','pending','code',s.pair_code,'now',now());
  end if;
  update public.screens
     set last_seen = now(),
         info = case when length(coalesce(p_info,'{}'::jsonb)::text) <= 4000 then coalesce(p_info,'{}'::jsonb) else info end
   where id = s.id;
  with d as (
    update public.screen_commands set done_at = now()
     where screen_id = s.id and done_at is null and created_at > now() - interval '10 minutes'
    returning id, cmd
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'cmd',cmd) order by id), '[]'::jsonb) into cmds from d;
  return jsonb_build_object('status', s.status, 'rev', (select rev from public.sig_rev where id = 1), 'cmds', cmds, 'now', now());
end $$;

-- Tivi lấy nội dung CỦA RIÊNG NÓ
create or replace function public.screen_manifest(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s public.screens; st public.sig_settings; g public.screen_groups;
begin
  s := public._screen_by_token(p_token);
  if s.id is null then return jsonb_build_object('status','unknown'); end if;
  if s.status <> 'active' then return jsonb_build_object('status', s.status); end if;
  select * into st from public.sig_settings where id = 1;
  select * into g from public.screen_groups where id = s.group_id;
  return jsonb_build_object(
    'status', 'active',
    'rev', (select rev from public.sig_rev where id = 1),
    'now', now(),
    'screen', jsonb_build_object('id', s.id, 'name', s.name, 'location', s.location, 'group', g.name),
    'settings', jsonb_build_object(
      'company', st.company, 'logo', st.logo, 'pin_lock', st.pin_lock,
      'ticker',   coalesce(nullif(s.ticker,''),   st.ticker),
      'lay',      coalesce(s.lay,                 st.lay),
      'sidenote', coalesce(nullif(s.sidenote,''), st.sidenote)),
    'slides', coalesce((
      select jsonb_agg(sl.data || jsonb_build_object('id', sl.id, 'type', sl.type) order by sl.sort)
        from public.slides sl
       where sl.enabled and sl.status = 'approved'
         and (sl.target_all or s.id = any(sl.target_screens) or (s.group_id is not null and s.group_id = any(sl.target_groups)))
    ), '[]'::jsonb),
    'alert', (
      select jsonb_build_object('id',a.id,'title',a.title,'msg',a.msg,'level',a.level,'sound',a.sound,'vol',a.vol,'at',a.starts_at,'until',a.until)
        from public.alerts a
       where a.active and a.starts_at <= now() and (a.until is null or a.until > now())
         and (a.target_all or s.id = any(a.target_screens) or (s.group_id is not null and s.group_id = any(a.target_groups)))
       order by case a.level when 'red' then 0 when 'orange' then 1 else 2 end, a.starts_at desc
       limit 1)
  );
end $$;

-- Kiểm tra PIN trên Tivi – giới hạn sai theo từng Tivi
create or replace function public.screen_verify_pin(p_token text, p text)
returns boolean language plpgsql volatile security definer set search_path = public, extensions as $$
declare s public.screens; h text; v_ok boolean;
begin
  s := public._screen_by_token(p_token);
  if s.id is null then raise exception 'Tivi chưa đăng ký'; end if;
  delete from public.pin_attempts where at < now() - interval '1 day';
  if (select count(*) from public.pin_attempts pa
       where pa.screen_id = s.id and not pa.ok and pa.at > now() - interval '10 minutes') >= 5 then
    raise exception 'Nhập sai quá nhiều lần, thử lại sau 10 phút';
  end if;
  select pin_hash into h from public.sig_secrets where id = 1;
  v_ok := h is not null and crypt(coalesce(p,''), h) = h;
  insert into public.pin_attempts (ok, screen_id) values (v_ok, s.id);
  return v_ok;
end $$;

-- Admin nhập mã 6 số để nhận Tivi
create or replace function public.screen_claim(p_code text, p_name text, p_location text default '', p_group uuid default null)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_admin() then raise exception 'Chỉ Admin được ghép nối Tivi'; end if;
  update public.screens
     set status = 'active', name = coalesce(nullif(trim(p_name),''), 'Tivi mới'), location = coalesce(p_location,''),
         group_id = p_group, pair_code = null, pair_expires = null, paired_at = now(), paired_by = public.my_email()
   where pair_code = trim(p_code) and status = 'pending' and pair_expires > now()
  returning id into sid;
  if sid is null then raise exception 'Mã không đúng hoặc đã hết hạn. Xem lại mã đang hiện trên Tivi.'; end if;
  return sid;
end $$;

revoke all on function public.screen_register(text)            from public;
revoke all on function public.screen_ping(text, jsonb)         from public;
revoke all on function public.screen_manifest(text)            from public;
revoke all on function public.screen_verify_pin(text, text)    from public;
revoke all on function public.screen_claim(text, text, text, uuid) from public, anon;
grant execute on function public.screen_register(text)         to anon, authenticated;
grant execute on function public.screen_ping(text, jsonb)      to anon, authenticated;
grant execute on function public.screen_manifest(text)         to anon, authenticated;
grant execute on function public.screen_verify_pin(text, text) to anon, authenticated;
grant execute on function public.screen_claim(text, text, text, uuid) to authenticated;
-- ---------------------------------------------------------------------
-- 5) NHẬP DỮ LIỆU TỪ APP CŨ (chỉ gọi từ SQL Editor – xem export_tu_app_cu.sql)
-- ---------------------------------------------------------------------
create or replace function public.import_v1(p_state jsonb, p_feeds jsonb default '[]'::jsonb)
returns text language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if exists (select 1 from public.slides) then
    raise exception 'Bảng slides đã có dữ liệu – không nhập lại để tránh bị trùng.';
  end if;
  insert into public.sig_feeds (id, kind, url, created_at)
  select (f->>'id')::uuid, f->>'kind', f->>'url', coalesce((f->>'created_at')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_feeds,'[]'::jsonb)) f
   where f->>'kind' in ('ics','csv')
  on conflict (id) do update set kind = excluded.kind, url = excluded.url;
  update public.sig_settings set
    company  = coalesce(p_state->>'company',''),
    ticker   = coalesce(p_state->>'ticker',''),
    logo     = coalesce(p_state->>'logo',''),
    lay      = case when p_state->>'lay' = 'side' then 'side' else 'full' end,
    sidenote = coalesce(p_state->>'sidenote',''),
    pin_lock = coalesce((p_state->>'pinLockEnabled')::boolean, false),
    migrated = true, updated_at = now()
  where id = 1;
  insert into public.slides (sort, type, data, enabled, status, created_by_email, created_at)
  select e.ord, e.val->>'type',
         e.val - 'type' - 'on' - 'status' - 'local' - 'createdBy' - 'createdAt' - 'updatedBy' - 'reviewedBy' - 'reviewedAt',
         coalesce((e.val->>'on')::boolean, true),
         case when e.val->>'status' in ('pending','approved','rejected') then e.val->>'status' else 'approved' end,
         e.val->>'createdBy', coalesce((e.val->>'createdAt')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_state->'slides','[]'::jsonb)) with ordinality as e(val, ord)
   where jsonb_typeof(e.val) = 'object' and e.val ? 'type';
  get diagnostics n = row_count;
  return format('Đã nhập %s slide và %s nguồn lịch/KPI từ app cũ.', n, jsonb_array_length(coalesce(p_feeds,'[]'::jsonb)));
end $$;
revoke all on function public.import_v1(jsonb, jsonb) from public, anon, authenticated;

-- Kiểm tra
select (select count(*) from public.slides) as so_slide,
       (select count(*) from public.screens) as so_man_hinh,
       (select rev from public.sig_rev) as rev;
