-- =====================================================================
-- XUẤT DỮ LIỆU TỪ APP CŨ → để nhập vào project Supabase MỚI
-- 1) Mở SQL Editor của project CŨ (celqybfrjzrxvhlhtrqo) → dán file này → Run
--    (chỉ ĐỌC dữ liệu, không thay đổi gì ở app cũ)
-- 2) Copy toàn bộ nội dung ô kết quả "lenh_nhap" (bấm vào ô → Copy cell)
-- 3) Mở SQL Editor của project MỚI → dán → Run
--    → hiện "Đã nhập ... slide và ... nguồn lịch/KPI từ app cũ."
-- Lưu ý: ảnh/video trong Thư viện vẫn nằm ở project cũ và vẫn hiển thị bình thường
-- miễn là project cũ còn hoạt động.
-- =====================================================================
select length(value::text) as kich_thuoc_byte,
       'select public.import_v1(' || quote_literal(value::text) || '::jsonb, '
       || quote_literal(coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'url', f.url, 'created_at', f.created_at))
                                    from public.sig_feeds f), '[]'::jsonb)::text)
       || '::jsonb);' as lenh_nhap
  from public.sig_data
 where key = 'signage_state';
