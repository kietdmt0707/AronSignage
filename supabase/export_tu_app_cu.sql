-- =====================================================================
-- CHUYỂN DỮ LIỆU: project CŨ (aron_signage)  →  project MỚI (Aron signage-db v2)
--
-- 1) Mở SQL Editor của project CŨ → dán file này → Run
--    (chỉ ĐỌC dữ liệu, không thay đổi gì ở app cũ)
-- 2) Bấm vào ô kết quả "lenh_nhap" → Copy cell
-- 3) Mở SQL Editor của project MỚI (đã chạy supabase_full.sql) → dán → Run
--    → hiện "✅ Đã nhập: ... tài khoản, ... phân quyền, ... slide, ... nguồn lịch/KPI."
--
-- Được chép: tài khoản đăng nhập (giữ mật khẩu cũ), phân quyền, mã PIN Tivi,
-- link lịch/Google Sheet, cài đặt chung, toàn bộ slide.
-- Ảnh/video trong Thư viện: chép bằng nút "📦 Chép thư viện từ app cũ" trong
-- trang quản trị mới (tab Cài đặt chung).
-- =====================================================================
select pg_size_pretty(length(x.j::text)::bigint) as kich_thuoc,
       'select public.import_v1(' || quote_literal(x.j::text) || '::jsonb);' as lenh_nhap
  from (select jsonb_build_object(
          'state',      (select value from public.sig_data where key = 'signage_state'),
          'feeds',      coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'url', f.url, 'created_at', f.created_at)) from public.sig_feeds f), '[]'::jsonb),
          'pin_hash',   (select pin_hash from public.sig_secrets where id = 1),
          'users',      coalesce((select jsonb_agg(to_jsonb(u)) from auth.users u), '[]'::jsonb),
          'identities', coalesce((select jsonb_agg(to_jsonb(i)) from auth.identities i), '[]'::jsonb),
          'roles',      coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'role', pr.role)) from public.profiles pr), '[]'::jsonb)
        ) as j) x;
