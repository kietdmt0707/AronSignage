-- =====================================================================
-- ARON Signage v2 – ĐỢT NÂNG CẤP 2
--   • Báo cáo phát (proof-of-play) + thời gian hoạt động của từng Tivi
--   • Nhật ký thao tác + khôi phục phiên bản slide
--   • Nguồn dữ liệu tùy chỉnh: RSS tin tức, Oracle BI Publisher / ORDS / API (đăng nhập giấu ở server)
-- Chạy trên project ĐÃ cài supabase_full.sql: SQL Editor → dán → Run (chạy lại vẫn an toàn)
-- (Cài mới từ đầu thì supabase_full.sql đã gồm sẵn phần này.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) THỐNG KÊ PHÁT (gom theo ngày để database nhỏ gọn)
-- ---------------------------------------------------------------------
create table if not exists public.play_stats (
  day        date not null,
  screen_id  uuid not null references public.screens(id) on delete cascade,
  slide_id   uuid not null,
  slide_type text not null default '',
  title      text not null default '',
  plays      int  not null default 0,
  seconds    int  not null default 0,
  primary key (day, screen_id, slide_id)
);
create index if not exists play_stats_slide_idx on public.play_stats (slide_id);

create table if not exists public.screen_uptime (
  day       date not null,
  screen_id uuid not null references public.screens(id) on delete cascade,
  seconds   int  not null default 0,
  primary key (day, screen_id)
);

alter table public.play_stats    enable row level security;
alter table public.screen_uptime enable row level security;
drop policy if exists "play_stats: staff xem" on public.play_stats;
create policy "play_stats: staff xem" on public.play_stats for select to authenticated using (public.is_staff());
drop policy if exists "uptime: staff xem" on public.screen_uptime;
create policy "uptime: staff xem" on public.screen_uptime for select to authenticated using (public.is_staff());

-- Tivi gửi kèm nhật ký phát trong mỗi lần ping (p_logs: [{id,type,t,at,dur}])
drop function if exists public.screen_ping(text, jsonb);
create or replace function public.screen_ping(p_token text, p_info jsonb default '{}'::jsonb, p_logs jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare s public.screens; cmds jsonb; gap numeric;
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

  -- Thời gian hoạt động: cộng khoảng cách giữa 2 lần ping (tối đa 90 giây, mất kết nối thì không tính)
  if s.status = 'active' and s.last_seen is not null then
    gap := extract(epoch from now() - s.last_seen);
    if gap > 0 and gap <= 90 then
      insert into public.screen_uptime (day, screen_id, seconds)
      values ((now() at time zone 'Asia/Ho_Chi_Minh')::date, s.id, round(gap)::int)
      on conflict (day, screen_id) do update set seconds = public.screen_uptime.seconds + excluded.seconds;
    end if;
  end if;

  update public.screens
     set last_seen = now(),
         info = case when length(coalesce(p_info,'{}'::jsonb)::text) <= 4000 then coalesce(p_info,'{}'::jsonb) else info end
   where id = s.id;

  -- Nhật ký phát → cộng dồn theo ngày / màn / slide
  if s.status = 'active' and jsonb_typeof(p_logs) = 'array' and jsonb_array_length(p_logs) > 0 then
    insert into public.play_stats (day, screen_id, slide_id, slide_type, title, plays, seconds)
    select d, s.id, sid, max(typ), max(ttl), count(*) filter (where not cont), sum(dur)
      from (select ((l->>'at')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date as d,
                   (l->>'id')::uuid as sid,
                   left(coalesce(l->>'type',''), 20) as typ,
                   left(coalesce(l->>'t',''), 120) as ttl,
                   least(greatest(coalesce((l->>'dur')::numeric, 0), 0), 86400)::int as dur,
                   coalesce(l->>'cont','') = 'true' as cont
              from (select l from jsonb_array_elements(p_logs) l limit 500) x
             where l->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (l->>'at') ~ '^\d{4}-\d{2}-\d{2}[T ]'
               and (l->>'at')::timestamptz between now() - interval '3 days' and now() + interval '5 minutes') v
     group by d, sid
    on conflict (day, screen_id, slide_id) do update
      set plays = public.play_stats.plays + excluded.plays,
          seconds = public.play_stats.seconds + excluded.seconds,
          title = excluded.title, slide_type = excluded.slide_type;
  end if;

  -- Dọn dữ liệu cũ hơn 400 ngày (thỉnh thoảng)
  if random() < 0.002 then
    delete from public.play_stats where day < current_date - 400;
    delete from public.screen_uptime where day < current_date - 400;
    delete from public.audit_log where at < now() - interval '400 days';
  end if;

  with d as (
    update public.screen_commands set done_at = now()
     where screen_id = s.id and done_at is null and created_at > now() - interval '10 minutes'
    returning id, cmd
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'cmd',cmd) order by id), '[]'::jsonb) into cmds from d;
  return jsonb_build_object('status', s.status, 'rev', (select rev from public.sig_rev where id = 1), 'cmds', cmds, 'now', now());
end $$;
revoke all on function public.screen_ping(text, jsonb, jsonb) from public;
grant execute on function public.screen_ping(text, jsonb, jsonb) to anon, authenticated;

-- Báo cáo tổng hợp cho trang quản trị
create or replace function public.report_summary(p_from date, p_to date, p_screen uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Không có quyền xem báo cáo'; end if;
  return jsonb_build_object(
    'by_slide', coalesce((
      select jsonb_agg(x order by x.plays desc) from (
        select p.slide_id, max(p.title) as title, max(p.slide_type) as type, sum(p.plays)::int as plays,
               sum(p.seconds)::int as seconds, count(distinct p.screen_id)::int as screens,
               exists (select 1 from public.slides sl where sl.id = p.slide_id) as still_exists
          from public.play_stats p
         where p.day between p_from and p_to and (p_screen is null or p.screen_id = p_screen)
         group by p.slide_id) x), '[]'::jsonb),
    'by_screen', coalesce((
      select jsonb_agg(x order by x.name) from (
        select sc.id as screen_id, sc.name,
               coalesce((select sum(plays) from public.play_stats p where p.screen_id = sc.id and p.day between p_from and p_to), 0)::int as plays,
               coalesce((select sum(seconds) from public.play_stats p where p.screen_id = sc.id and p.day between p_from and p_to), 0)::int as play_seconds,
               coalesce((select sum(seconds) from public.screen_uptime u where u.screen_id = sc.id and u.day between p_from and p_to), 0)::int as uptime_seconds
          from public.screens sc
         where sc.status <> 'pending' and (p_screen is null or sc.id = p_screen)) x), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(x order by x.day) from (
        select p.day, sum(p.plays)::int as plays, sum(p.seconds)::int as seconds
          from public.play_stats p
         where p.day between p_from and p_to and (p_screen is null or p.screen_id = p_screen)
         group by p.day) x), '[]'::jsonb)
  );
end $$;
revoke all on function public.report_summary(date, date, uuid) from public, anon;
grant execute on function public.report_summary(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2) NHẬT KÝ THAO TÁC + KHÔI PHỤC
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_email text,
  action      text not null,          -- INSERT / UPDATE / DELETE
  table_name  text not null,
  row_id      text,
  old_row     jsonb,
  new_row     jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_row_idx on public.audit_log (table_name, row_id);
alter table public.audit_log enable row level security;
drop policy if exists "audit: editor xem" on public.audit_log;
create policy "audit: editor xem" on public.audit_log for select to authenticated using (public.is_editor());

create or replace function public.audit_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb;
begin
  o := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  if tg_op = 'UPDATE' and (o - 'updated_at' - 'updated_by_email' - 'last_seen' - 'info') = (n - 'updated_at' - 'updated_by_email' - 'last_seen' - 'info') then
    return null;  -- không có thay đổi thật
  end if;
  if tg_table_name = 'screens' then  -- không lưu mã bí mật của Tivi
    o := o - 'token_hash' - 'info'; n := n - 'token_hash' - 'info';
  end if;
  insert into public.audit_log (actor_email, action, table_name, row_id, old_row, new_row)
  values (coalesce(public.my_email(), case when auth.role() is null then 'SQL / hệ thống' else 'Tivi' end),
          tg_op, tg_table_name, coalesce(n->>'id', o->>'id'), o, n);
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['slides','screen_groups','alerts','sig_settings','profiles'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_trg()', t);
  end loop;
end $$;
drop trigger if exists audit_screens on public.screens;
create trigger audit_screens after update of name, location, group_id, status, ticker, lay, sidenote or delete on public.screens
  for each row execute function public.audit_trg();
-- Ghép nối Tivi (pending → active) cũng được ghi nhờ cột status ở trên.

-- Khôi phục 1 slide về đúng phiên bản trong nhật ký (kể cả slide đã bị xóa)
create or replace function public.restore_slide(p_audit_id bigint)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare a public.audit_log; r jsonb;
begin
  if not public.is_editor() then raise exception 'Chỉ Editor/Admin được khôi phục'; end if;
  select * into a from public.audit_log where id = p_audit_id and table_name = 'slides';
  if a.id is null then raise exception 'Không tìm thấy bản ghi nhật ký'; end if;
  r := coalesce(a.old_row, a.new_row);
  if r is null then raise exception 'Bản ghi không có dữ liệu để khôi phục'; end if;
  insert into public.slides (id, sort, type, data, enabled, status, target_all, target_groups, target_screens)
  values ((r->>'id')::uuid, (r->>'sort')::double precision, r->>'type', r->'data', (r->>'enabled')::boolean,
          coalesce(r->>'status','approved'), (r->>'target_all')::boolean,
          coalesce(array(select jsonb_array_elements_text(r->'target_groups'))::uuid[], '{}'),
          coalesce(array(select jsonb_array_elements_text(r->'target_screens'))::uuid[], '{}'))
  on conflict (id) do update set sort = excluded.sort, type = excluded.type, data = excluded.data, enabled = excluded.enabled,
     status = excluded.status, target_all = excluded.target_all, target_groups = excluded.target_groups, target_screens = excluded.target_screens;
  return (r->>'id')::uuid;
end $$;
revoke all on function public.restore_slide(bigint) from public, anon;
grant execute on function public.restore_slide(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 3) NGUỒN DỮ LIỆU TÙY CHỈNH
-- ---------------------------------------------------------------------
alter table public.sig_feeds drop constraint if exists sig_feeds_kind_check;
alter table public.sig_feeds add constraint sig_feeds_kind_check check (kind in ('ics','csv','rss'));

-- Tên miền được phép lấy dữ liệu (ngoài Google/Microsoft có sẵn) – Admin quản lý trong trang Cài đặt
create table if not exists public.sig_feed_hosts (
  host       text primary key check (host ~ '^[a-z0-9.-]+$'),
  note       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.sig_feed_hosts enable row level security;
drop policy if exists "hosts: staff xem" on public.sig_feed_hosts;
drop policy if exists "hosts: admin thêm" on public.sig_feed_hosts;
drop policy if exists "hosts: admin xóa" on public.sig_feed_hosts;
create policy "hosts: staff xem"  on public.sig_feed_hosts for select to authenticated using (public.is_staff());
create policy "hosts: admin thêm" on public.sig_feed_hosts for insert to authenticated with check (public.is_admin());
create policy "hosts: admin xóa"  on public.sig_feed_hosts for delete to authenticated using (public.is_admin());
insert into public.sig_feed_hosts (host, note) values
  ('vnexpress.net','Tin tức VnExpress'), ('tuoitre.vn','Tin tức Tuổi Trẻ'), ('thanhnien.vn','Tin tức Thanh Niên'),
  ('cafef.vn','Tin kinh tế CafeF'), ('vietnamnet.vn','Tin tức VietNamNet')
on conflict (host) do nothing;

-- Tài khoản đăng nhập nguồn (VD: Oracle BI Publisher) – KHÔNG ai đọc được từ trình duyệt,
-- chỉ Edge Function "feed" (service role) dùng để gọi nguồn.
create table if not exists public.sig_feed_secrets (
  feed_id   uuid primary key references public.sig_feeds(id) on delete cascade,
  auth_user text,
  auth_pass text
);
alter table public.sig_feed_secrets enable row level security;   -- không có policy = không ai đọc

create or replace function public.set_feed_auth(p_feed uuid, p_user text, p_pass text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_editor() then raise exception 'Chỉ Editor/Admin được lưu tài khoản nguồn dữ liệu'; end if;
  if not exists (select 1 from public.sig_feeds where id = p_feed) then raise exception 'Không tìm thấy nguồn'; end if;
  if coalesce(p_user,'') = '' then delete from public.sig_feed_secrets where feed_id = p_feed; return; end if;
  insert into public.sig_feed_secrets (feed_id, auth_user, auth_pass) values (p_feed, p_user, p_pass)
  on conflict (feed_id) do update set auth_user = excluded.auth_user,
     auth_pass = case when coalesce(excluded.auth_pass,'') = '' then public.sig_feed_secrets.auth_pass else excluded.auth_pass end;
end $$;
create or replace function public.feed_auth_user(p_feed uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when public.is_editor() then (select auth_user from public.sig_feed_secrets where feed_id = p_feed) end $$;
revoke all on function public.set_feed_auth(uuid, text, text) from public, anon;
revoke all on function public.feed_auth_user(uuid) from public, anon;
grant execute on function public.set_feed_auth(uuid, text, text) to authenticated;
grant execute on function public.feed_auth_user(uuid) to authenticated;

select 'Đợt nâng cấp 2 đã cài xong' as ket_qua;
