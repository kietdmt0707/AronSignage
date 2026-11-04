// =====================================================================
// ARON Signage v2 – Cấu hình kết nối Supabase
// Lấy ở: Supabase Dashboard (project MỚI) → Project Settings → API Keys
//   url : Project URL           (dạng https://xxxxxxxx.supabase.co)
//   key : Publishable key       (dạng sb_publishable_...)  ← KHÔNG dùng secret/service_role key
// Publishable key được phép để công khai: dữ liệu được bảo vệ bằng RLS trên server.
// =====================================================================
window.SIGNAGE_CONFIG = {
  url: 'https://mgydhkatkujlhozrixip.supabase.co',   // VD: 'https://abcdefghijklmnop.supabase.co'
  key: 'sb_publishable_EvCI8rx77Ayff9B-GrsFiA_tXHfAyuG',   // VD: 'sb_publishable_xxxxxxxxxxxxxxxx'

  // Project CŨ – chỉ dùng cho nút "📦 Chép thư viện từ app cũ" (tab Cài đặt chung).
  // Chuyển xong có thể xóa khối này.
  old: {
    url: 'https://celqybfrjzrxvhlhtrqo.supabase.co',
    key: 'sb_publishable_oxu9CsROYb_POoS7z7bwkw_hgejeEBC'
  }
};
